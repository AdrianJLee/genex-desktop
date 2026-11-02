/**
 * The language the agents write to the person in: the one the person writes in, and, for a turn that
 * starts from a line marked as Genex's or when the person's language is unclear, the one Genex is set
 * to, so those turns never pull the chat back to English. Code and the agents' own files stay English.
 */
import type { AppLanguage } from "./app-language.ts";

/** Where Genex's own messages are answered, when the host named its language. */
function fallback(app: AppLanguage | null | undefined): string {
  return app
    ? ` When a turn starts from a line marked as Genex's rather than the user's, or the user's language is unclear, write in ${app.name} (${app.tag}), the language the user set Genex to.`
    : "";
}

/** The builder's rule: every word the person reads in the person's language. */
export function languageRule(app: AppLanguage | null | undefined): string {
  return `Write everything the user reads (your replies, questions, plans and progress notes) in the language the user writes to you in.${fallback(app)} Code, file names and commit messages stay in English.`;
}
