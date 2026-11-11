# From a level to a world

An art level is never written by hand. Its collision becomes the room's world in two steps at build time: an **exporter** writes the
engine-neutral [scene](#the-scene), and **`genex world fit`** fits a world to what a body can reach. The room module and the game then load
one file, so prediction and the room share a hash. Both steps are local files: no sign-in, no network, nothing billed.

```sh
genex world fit level.scene.json level.world.json --report fit.json
genex world shots level.scene.json level.shots.json --report shots.json   # only if bullets differ: below
```

```js
// server/room.js
import WORLD from "../level.world.json";
import SHOTS from "../level.shots.json";

export default defineRoom({ /* … */ world: WORLD, shotWorld: SHOTS });
```

`genex world fit` exits 3 and writes nothing when a level does not fit: it names the actors that cost most and what each would lose as
one box. Give those simple collision or fewer triangles and fit again. Fit again whenever the level changes, and ship the room and the
game together. Rebuilding the world while a player waits gives another hash by one rounded float, so the game draws the player from the
server instead of predicting them.

## Your engine

### three.js, or any engine with a glTF exporter

```sh
genex world gltf level.glb level.scene.json
```

The scene a three.js game already holds, loaded or built in code, goes through `sceneFromThree` from
`@genex-ai/multiplayer/world-fit/three`: `const { json, notes } = sceneFromThree(gltf, { scale: 39.37 })`, then write `json` to the scene file. Say what collides in the node names (or `extras.genex`, `userData.genex`): unmarked meshes collide;
`nocol_` is only drawn, `clip_` stops a player and not a bullet, `shot_` stops a bullet and not a player, `box_` and `hull_` simplify,
`movable_` moves at run time and stays out, `prop_` may be cut when a budget runs out, and an empty `spawn_Red_1` is where a player
starts. A level with no spawn cannot be fitted, and standing it on the floor means no correction at join. Units are metres in a glb, 39.37 room
units each unless the scene's `extras.genex.unitsPerMeter` says otherwise. Skinned meshes, Draco and meshopt on what collides are refused by
name, and the refusal says what to do; `packages/multiplayer/WORLD-GLTF.md` in the SDK has the whole table. Hand the world to
`connectAuthority({ …, world })`, draw the same glb in the same units (`gltf.scene.scale.setScalar(39.37)`), and check
`session.prediction.predicting` is true while you walk it.

### Unreal

```
UnrealEditor-Cmd MyGame.uproject -run=GenexMultiplayerEditor.GenexFitCollision -Map=/Game/Maps/MyLevel
```

or `Genex.FitCollisionWorld` in the editor's console. It reads the level's collision, Landscape, BSP and spline meshes included, runs
`genex world fit` and writes a `UGenexCollisionWorld` asset and `Saved/Genex/MyLevel.world.json` with one hash. Hand the asset to
`SetWorldFromAsset` and import the JSON in the room module. `ShotChannel=` says what stops a bullet, by default Visibility, so the same
scene file feeds `genex world shots`. The SDK's README has every option.

### Unity

Open the level and use **Genex > Export World Scene...**, or in batch `Unity -batchmode -nographics -quit -projectPath . -executeMethod
Genex.Multiplayer.WorldExport.GenexWorldExporter.RunBatch -genexScene Assets/Scenes/Level.unity -genexOut level.scene.json`. Then fit it.
The room module exports the file, and the game loads it: `GenexFirstpersonWorld.FromJson(worldTextAsset.text)`, then `SetWorld(world)` on the session. Layers
are channels: the collision matrix says what stops a hull, `-genexShotLayers` what stops a bullet.

### Rust

Any level as a glb, through `genex world gltf`. `FirstpersonWorld::from_json_str` loads the file.

### Godot (last priority: the smallest path, and the least tested)

`GenexWorldExport.write_scene(level_root, "level.scene.json")`, from `genex_world_export.gd` in the addon, with the level in the tree. Then fit it, and
`set_world_json` loads the file. Layers are channels: `move_mask` stops a hull, `shot_mask` a bullet. The SDK's README has what it reads.

## The scene

`packages/multiplayer/WORLD-SCENE.md` has the format, if your engine has no exporter yet: actors by name, surfaces in world space, z up.
`channels` on a surface says which traces it answers: a clip wall is `["move"]`, a screen a bullet stops and a body walks through is
`["shot"]`, and left out means both. Write everything that collides: the fit decides what a body can reach and drops the rest.

## What bullets meet

A world fitted for bodies is wrong for bullets in three ways: a clip wall stops them, a fence with no body-stopping solid does not, and
what no body can touch is not there. Three choices, each on top of the last:

1. **`ctx.world.ray(eye, dir, { range: 4096 })`** asks the room's world. Enough when what stops a body stops a bullet.
2. **`ctx.world.ray(eye, dir, { range: 4096, world: "shot" })`** asks the module's `shotWorld`, which `genex world shots` fits on the trace
   channel: what a muzzle can see from where a body can be, what no body reaches included. A room without one is never answered from its
   `world`: the call throws naming `no_shot_world`, and `authority validate` fails `shot_world_missing`. A module with several `worlds` names a `shotWorlds` entry for each, with a
   `shotWorld` for any other room, or it does not load. It has no hash and no client knows it. Its cost is real: it is in the module's bytes and the sandbox's
   memory, and `authority validate` fails `shot_world_cost` when a ray costs a room's budget. The fit's report says how far its stops are
   from the source's surfaces and on what share of rays the two disagree. Exit 3 names the actors when it does not fit its budget.
3. **`ctx.world.claim(eye, dir, claimed, { range: 4096 })`** takes the stop the shooter's own client saw on the mesh it draws, and holds it to
   the shot world. A claimed stop is as exact as what the player sees, and costs what a ray costs.

### A claimed stop

The client traces what it draws and sends the distance on `moveZ`, which neither movement preset reads and every transport carries:

```ts
import { claimToAxis } from "@genex-ai/multiplayer/authority";

const RANGE = 4096;
const hit = raycaster.intersectObject(level, true)[0]; // units as the room's: scale them if you draw in other ones
session.input.moveZ = claimToAxis(hit ? hit.distance : null, RANGE); // only on the input that fires
```

On any other engine: `moveZ = distance < RANGE ? 2 * distance / RANGE - 1 : 1`, and 1 says the shot flew on.

```js
const WEAPONS = {
  pistol: {},
  rifle: { pierce: 16 }, // goes through one wall up to 16 units thick
  rocket: { tolerance: 0, rule: (c) => (c.server === null ? c.dist : c.server) }, // bursts where the world says, never in the air
};
const claimOf = (axis) => (axis >= 1 ? null : ((axis + 1) * RANGE) / 2);

function fire(ctx, playerId, me, input, weapon) {
  const stop = ctx.world.claim(eye, dir, claimOf(input.moveZ), { range: RANGE, ...WEAPONS[weapon] });
  if (stop === null) return; // a ray that is none
  const target = ctx.rewind.hitscan(lowered, dir, { range: stop.dist, radius: HIT_RADIUS, kinds: ["player"] });
  ctx.emit("shot", { shooter: playerId, hit: target && target.id, impact: stop.point });
}
```

`stop.dist` is how far the shot flies. `stop.verdict` says why:

| Verdict | When | `dist` |
|---|---|---|
| `accepted` | Within the tolerance of the shot world's stop | The claim |
| `refused` | Past the world's stop by more than the tolerance: a claim through a wall | The world's stop |
| `capped` | Short of the world's stop by more than the tolerance | The world's stop, less the tolerance |
| `pierced` | Past it, through one wall no longer than `pierce` | The claim |
| `ruled` | Your `rule` returned a distance | That distance |

- **The tolerance is the cheat margin, and you can read it.** It is the shot world's `tolerance`, unless a weapon names its own: how far off a
  surface a stop may be. A hacked client can hit a body within that distance behind a wall face, and no further, however thin the wall.
  Along a ray that grazes a surface it reaches further, up to 4 times, because it is measured off the surface.
- **What it costs honest players.** A ray that really misses an edge by less than the shot world's cell stops there, as `claim` can't tell it
  from one through the wall. `genex world shots --report` gives that share at the stated tolerance and at others (`claims`). A
  finer cell (a bigger budget) makes both smaller; a higher tolerance trades honest shots for margin.
- **A wall of two faces is two walls to `pierce`.** A mesh wall has air inside it. A second surface further than `pierce` past the first is
  another wall, and the shot stops at the first.
- **A door, a lift or a crate you move** is your own rule, as with `ray`: the shot world is static, and `genex world shots` names what it left out.
