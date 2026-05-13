/**
 * Side-effect module: sets PI_APP_NAME / PI_APP_TITLE before the
 * coding-agent's config module evaluates and freezes APP_NAME constants.
 *
 * Imported first in cli.ts; ESM evaluates dependencies depth-first in source
 * order, so this module's top-level statements run before the coding-agent
 * module graph is initialized.
 */

process.env.PI_APP_NAME ??= "strudel";
process.env.PI_APP_TITLE ??= "strudel";
process.title = "strudel";
