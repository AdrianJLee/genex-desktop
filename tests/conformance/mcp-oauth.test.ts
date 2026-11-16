import { test } from "node:test";
import assert from "node:assert/strict";
import { McpOAuthAccount } from "../../src/substrate/mcp/oauth.ts";
import { McpSessionSecrets } from "../../src/substrate/mcp/session-secrets.ts";
import { memorySecretPort } from "../../src/substrate/mcp/store.ts";
import { McpRegistry } from "../../src/substrate/mcp/registry.ts";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MCP_URL = "https://docs.example/mcp";
const TRUSTED_HOST = "identity.example";
const ATTACKER_HOST = "attacker.example";

/** The secrets an authorization server at `host` hands out. */
const issuedBy = (host: string) => ({
  access: `access-PRIVATE-${host}`,
  refresh: `refresh-PRIVATE-${host}`,
  clientSecret: `client-PRIVATE-${host}`,
});
/** What the trusted authorization server hands out: none of it may reach anyone else. */
const TRUSTED = issuedBy(TRUSTED_HOST);

/** One request as a fixture host saw it. */
type Sent = { host: string; path: string; body: string; authorization: string };

/** How the trusted authorization server answers RFC 7009 revocation, or the endpoint it names instead. */
type Revocation = "offered" | "absent" | "failing" | { endpoint: string };

/** The revocation endpoint an authorization server names in its metadata, as `revocation` asks. */
function revokingAt(issuer: string, revocation: Revocation): { revocation_endpoint?: string } {
  if (typeof revocation === "object") return { revocation_endpoint: revocation.endpoint };
  if (revocation === "absent") return {};
  return { revocation_endpoint: `${issuer}/revoke` };
}

/** What an authorization server says about itself; only the trusted one's revocation varies. */
function serverMetadata(issuer: string, revocation: Revocation) {
  const revoking = revokingAt(issuer, revocation);
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    ...revoking,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  };
}

/** How the authorization server at `url.host` answers: metadata, registration, tokens and revocation. */
function serverAnswer(url: URL, body: string, revocation: Revocation): Response {
  const issuer = `https://${url.host}`;
  const issued = issuedBy(url.host);
  if (url.pathname.startsWith("/.well-known/")) return Response.json(serverMetadata(issuer, revocation));
  if (url.pathname === "/register")
    return Response.json({
      ...JSON.parse(body),
      client_id: `client-of-${url.host}`,
      client_secret: issued.clientSecret,
      token_endpoint_auth_method: "client_secret_post",
    });
  if (url.pathname === "/token")
    return Response.json({
      access_token: issued.access,
      refresh_token: issued.refresh,
      token_type: "Bearer",
      expires_in: 3600,
    });
  if (url.pathname === "/revoke") return new Response("", { status: revocation === "failing" ? 503 : 200 });
  return new Response("", { status: 404 });
}

/**
 * A connected MCP server and two authorization servers: the one it names at sign-in, and another it
 * can name afterwards (`names`). Each registers clients with a secret, issues tokens and revokes
 * them; every request is recorded. A loopback URL is passed to the real fetch, redirects and all.
 */
function oauthWorld(revocation: Revocation = "offered") {
  const sent: Sent[] = [];
  const world = {
    names: `https://${TRUSTED_HOST}`,
    sent,
    connected: () => {},
    fetchImpl: undefined as unknown as typeof fetch,
  };
  world.fetchImpl = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "127.0.0.1") return fetch(input, init);
    const body = init?.body ? String(init.body) : "";
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    sent.push({ host: url.host, path: url.pathname, body, authorization });
    if (url.host !== "docs.example") return serverAnswer(url, body, url.host === TRUSTED_HOST ? revocation : "offered");
    if (!url.pathname.includes("oauth-protected-resource")) return new Response("", { status: 404 });
    return Response.json({ resource: MCP_URL, authorization_servers: [world.names] });
  };
  return world;
}
type OAuthWorld = ReturnType<typeof oauthWorld>;

/** Whether a request carries a secret the trusted authorization server issued. */
const carriesTrustedSecret = (request: { body: string; authorization?: string }) =>
  Object.values(TRUSTED).some(
    (secret) => request.body.includes(secret) || (request.authorization ?? "").includes(secret),
  );

/** The requests in `sent` that reached `host` with a trusted secret on them, as `path: body` lines. */
const secretsAt = (sent: Sent[], host: string) =>
  sent.filter((r) => r.host === host && carriesTrustedSecret(r)).map((r) => `${r.path}: ${r.body}`);

/** An account for the docs connector whose storage is `values`, living in `world`. */
function accountIn(world: OAuthWorld, values: Map<string, string>): McpOAuthAccount {
  return new McpOAuthAccount(
    "docs",
    MCP_URL,
    memorySecretPort(values),
    () => {},
    async () => world.connected(),
    world.fetchImpl,
  );
}

/** A full local sign-in, as Connect runs it: discovery, registration, browser return, code exchange. */
async function signIn(world: OAuthWorld, account: McpOAuthAccount): Promise<McpOAuthAccount> {
  const connected = new Promise<void>((resolve) => {
    world.connected = resolve;
  });
  let opened = "";
  const provider = await account.begin(async (url) => {
    opened = url;
  });
  const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
  assert.equal(await auth(provider, { serverUrl: MCP_URL, fetchFn: world.fetchImpl }), "REDIRECT");
  const state = new URL(opened).searchParams.get("state") ?? "";
  const back = await fetch(`${provider.redirectUrl}?state=${state}&code=code-1`);
  assert.equal(back.status, 200);
  await connected;
  assert.equal(account.state, "connected");
  return account;
}

/** A token refresh, as the transport runs one when the server answers 401; a refusal is returned, not thrown. */
async function refresh(account: McpOAuthAccount, world: OAuthWorld): Promise<unknown> {
  const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
  return auth(account.provider(), { serverUrl: MCP_URL, fetchFn: world.fetchImpl }).catch((error: Error) => error);
}

/** A record saved before the recipient was pinned: the trusted server's tokens and client secret, and nothing about who issued them. */
const OLD_RECORD = JSON.stringify({
  tokens: { access_token: TRUSTED.access, refresh_token: TRUSTED.refresh, token_type: "Bearer" },
  client: { client_id: `client-of-${TRUSTED_HOST}`, client_secret: TRUSTED.clientSecret },
  redirect: "http://127.0.0.1:53123/mcp/callback",
});

/** The revocations the trusted server received, as `token_type_hint` values in order. */
const revokedAtTrusted = (sent: Sent[]) =>
  sent
    .filter((r) => r.host === TRUSTED_HOST && r.path === "/revoke")
    .map((r) => new URLSearchParams(r.body).get("token_type_hint"));

test("OAuth cannot unlock or open a browser from background provider methods; cancel invalidates pending writes", async () => {
  const values = new Map<string, string>();
  let reads = 0;
  const store = memorySecretPort(values);
  // Offline: the disconnect at the end asks for revocation, and no test reaches a real server.
  const offline: typeof fetch = async () => {
    throw new Error("offline");
  };
  const account = new McpOAuthAccount(
    "docs",
    "https://docs.example/mcp",
    {
      ...store,
      get: async (key) => {
        reads++;
        return store.get(key);
      },
    },
    () => {},
    async () => {},
    offline,
  );
  assert.throws(() => account.provider().tokens(), /Connect/);
  assert.equal(reads, 0);
  let opened = 0;
  try {
    const p = await account.begin(async () => {
      opened++;
    });
    assert.equal(reads, 1);
    await p.saveCodeVerifier("verifier");
    await p.redirectToAuthorization(new URL("https://identity.example/authorize"));
    assert.equal(opened, 1);
    assert.equal(account.state, "authorizing");
    const invalid = await fetch(`${p.redirectUrl}?state=forged&code=unused`);
    assert.equal(invalid.status, 400);
    account.cancel();
    await assert.rejects(
      Promise.resolve().then(() => p.saveTokens({ access_token: "must-not-save", token_type: "Bearer" })),
      /Connect/,
    );
    assert.equal(
      [...values.values()].some((v) => v.includes("must-not-save")),
      false,
    );
    const next = await account.begin(async () => {});
    assert.equal(reads, 1, "the unlocked session survives cancelled browser sign-in");
    await next.saveTokens({ access_token: "approved-token", token_type: "Bearer" });
    assert.ok([...values.values()].some((v) => v.includes("approved-token")));
    await account.disconnect();
    assert.equal(values.size, 0);
    assert.throws(() => next.tokens(), /Connect/);
  } finally {
    account.lock();
  }
});

test("MCP secret discovery never opens storage and explicit concurrent connects share a read", async () => {
  let reads = 0;
  const values = new Map([["mcp.docs.header.Authorization", "Bearer test"]]);
  const store = memorySecretPort(values);
  const lease = new McpSessionSecrets({
    ...store,
    get: async (key) => {
      reads++;
      return store.get(key);
    },
  });
  const connector = { id: "docs", headers: ["Authorization"] } as Parameters<typeof lease.unlock>[0];
  assert.equal((await lease.list()).length, 1);
  assert.equal(reads, 0);
  await assert.rejects(lease.get("mcp.docs.header.Authorization"), /locked/);
  await Promise.all([lease.unlock(connector), lease.unlock(connector)]);
  assert.equal(reads, 1);
  assert.equal(await lease.get("mcp.docs.header.Authorization"), "Bearer test");
  assert.equal(reads, 1);
  lease.lock("docs");
  await assert.rejects(lease.get("mcp.docs.header.Authorization"), /locked/);
});

test("late OAuth errors redact rotated credentials after lock without retaining token authority", async () => {
  const account = new McpOAuthAccount(
    "docs",
    "https://docs.example/mcp",
    memorySecretPort(new Map()),
    () => {},
    async () => {},
  );
  try {
    const [p, other] = await Promise.all([account.begin(async () => {}), account.begin(async () => {})]);
    assert.equal(p, other, "duplicate Connect uses one callback and provider");
    const redact = account.redactor();
    await p.saveTokens({ access_token: "first-private-token", token_type: "Bearer" });
    await p.saveTokens({
      access_token: "rotated-private-token",
      refresh_token: "private-refresh",
      token_type: "Bearer",
    });
    account.lock();
    assert.throws(() => p.tokens(), /Connect/);
    assert.equal(
      redact("late first-private-token rotated-private-token private-refresh"),
      "late [redacted] [redacted] [redacted]",
    );
  } finally {
    account.lock();
  }
});

test("disconnect revokes the tokens at the authorization server of the sign-in, then forgets them (MCP-6)", async () => {
  const world = oauthWorld();
  const values = new Map<string, string>();
  const account = await signIn(world, accountIn(world, values));
  await account.disconnect();
  assert.equal(values.size, 0, "the local record is gone");
  const revocations = world.sent
    .filter((r) => r.path === "/revoke")
    .map((r) => Object.fromEntries(new URLSearchParams(r.body)));
  assert.deepEqual(revocations, [
    {
      token: TRUSTED.refresh,
      token_type_hint: "refresh_token",
      client_id: `client-of-${TRUSTED_HOST}`,
      client_secret: TRUSTED.clientSecret,
    },
    {
      token: TRUSTED.access,
      token_type_hint: "access_token",
      client_id: `client-of-${TRUSTED_HOST}`,
      client_secret: TRUSTED.clientSecret,
    },
  ]);
  assert.equal(account.state, "signed-out");
});

test("a server without revocation, one whose revocation fails, or a record saved before the pin still has the account forgotten here (MCP-6)", async () => {
  // Rows: how revocation stands, whether the account signed in after the fix, and the revocations expected.
  const rows = [
    { revocation: "absent", signedIn: true, expected: [] },
    { revocation: "failing", signedIn: true, expected: ["refresh_token", "access_token"] },
    // Flipped: a record saved before the pin has no verified recipient, so nothing is revoked.
    { revocation: "offered", signedIn: false, expected: [] },
  ] as const;
  for (const row of rows) {
    const world = oauthWorld(row.revocation);
    const values = new Map<string, string>();
    const account = accountIn(world, values);
    if (row.signedIn) await signIn(world, account);
    else values.set(account.key, OLD_RECORD);
    const before = world.sent.length;
    await account.disconnect();
    assert.equal(values.size, 0, `${row.revocation}: the local record is gone`);
    assert.deepEqual(revokedAtTrusted(world.sent), row.expected, `${row.revocation}: revocations`);
    if (!row.signedIn) assert.deepEqual(world.sent.slice(before), [], "an old record asks no one at disconnect");
  }
});

test("removing an OAuth connector revokes its tokens even when it was never connected this session (MCP-6)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-mcp-revoke-"));
  const world = oauthWorld();
  const values = new Map<string, string>();
  // Signed in during an earlier session: the record is in storage, and this session never unlocked it.
  (await signIn(world, accountIn(world, values))).lock();
  const registry = new McpRegistry({
    file: path.join(root, "connectors.json"),
    secrets: memorySecretPort(values),
    fetchImpl: world.fetchImpl,
  });
  try {
    await registry.init();
    await registry.save({
      id: "docs",
      name: "Docs",
      transport: "http",
      url: MCP_URL,
      authentication: "oauth",
      enabled: true,
      scope: "global",
      toolPolicy: {},
    });
    await registry.remove("docs");
    assert.equal(values.size, 0);
    assert.deepEqual(revokedAtTrusted(world.sent), ["refresh_token", "access_token"]);
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("after sign-in, a server that names another authorization server gets none of the account's secrets sent there", async () => {
  // Rows: how the account came to hold its secrets, what Genex does after the server changed its
  // answer, and the state the account ends in.
  const rows = [
    { record: "signed in", act: "disconnect", ends: "signed-out" },
    { record: "signed in", act: "refresh", ends: "connected" },
    { record: "saved before the fix", act: "disconnect", ends: "signed-out" },
    { record: "saved before the fix", act: "refresh", ends: "signed-out" },
  ] as const;
  const leaks: string[] = [];
  const ended: string[] = [];
  for (const row of rows) {
    const world = oauthWorld();
    const values = new Map<string, string>();
    const account = accountIn(world, values);
    if (row.record === "signed in") await signIn(world, account);
    else values.set(account.key, OLD_RECORD);
    try {
      if (row.record !== "signed in" && row.act === "refresh") await account.unlock();
      world.names = `https://${ATTACKER_HOST}`;
      if (row.act === "disconnect") await account.disconnect();
      else await refresh(account, world);
      for (const line of secretsAt(world.sent, ATTACKER_HOST)) leaks.push(`${row.record}, ${row.act}: ${line}`);
      ended.push(`${row.record}, ${row.act}: ${account.state}`);
    } finally {
      account.lock();
    }
  }
  assert.deepEqual(leaks, [], "no secret reaches the authorization server the server named after sign-in");
  assert.deepEqual(
    ended,
    rows.map((row) => `${row.record}, ${row.act}: ${row.ends}`),
    "a refresh stays at the pinned server; an old record's refresh asks for a new sign-in",
  );
});

test("a revocation that the authorization server redirects to another origin is not followed there", async () => {
  const { createServer } = await import("node:http");
  const received: string[] = [];
  const stranger = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push(`${request.method} ${request.url} ${body}`);
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve) => stranger.listen(0, "127.0.0.1", () => resolve()));
  const strangerPort = (stranger.address() as { port: number }).port;
  const revoker = createServer((_request, response) => {
    response.writeHead(307, { Location: `http://127.0.0.1:${strangerPort}/collect` }).end();
  });
  await new Promise<void>((resolve) => revoker.listen(0, "127.0.0.1", () => resolve()));
  const revokerPort = (revoker.address() as { port: number }).port;
  try {
    const world = oauthWorld({ endpoint: `http://127.0.0.1:${revokerPort}/revoke` });
    const values = new Map<string, string>();
    const account = await signIn(world, accountIn(world, values));
    await account.disconnect();
    assert.equal(values.size, 0, "the account is still forgotten here");
    assert.deepEqual(
      received.filter((line) => carriesTrustedSecret({ body: line })),
      [],
      "nothing secret reached the other origin",
    );
  } finally {
    for (const server of [stranger, revoker]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("an account saved before the fix signs in once again, and from then on its secrets stay with that server", async () => {
  const world = oauthWorld();
  const values = new Map<string, string>();
  const account = accountIn(world, values);
  values.set(account.key, OLD_RECORD);
  try {
    await account.unlock();
    await refresh(account, world);
    assert.deepEqual(
      world.sent.filter(carriesTrustedSecret),
      [],
      "the old record's secrets go nowhere, not even to the server that issued them",
    );
    assert.equal(account.state, "signed-out", "the card asks for Connect instead of showing a connection");
    assert.equal(values.get(account.key)?.includes(TRUSTED.refresh), false, "the old tokens are gone from storage");
    await signIn(world, account);
    world.names = `https://${ATTACKER_HOST}`;
    const before = world.sent.length;
    await account.disconnect();
    assert.deepEqual(secretsAt(world.sent.slice(before), ATTACKER_HOST), []);
    assert.deepEqual(revokedAtTrusted(world.sent.slice(before)), ["refresh_token", "access_token"]);
  } finally {
    account.lock();
  }
});
