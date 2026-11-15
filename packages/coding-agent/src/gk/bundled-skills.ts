/**
 * Skills shipped with gk-code under `src/gk/skills/<name>/`. Discovered at the lowest skill priority
 * and resolved after every authored skill, so a user or project skill of the same name replaces the
 * bundled copy instead of colliding with it.
 */
import * as path from "node:path";

export const GK_BUNDLED_SKILLS_PROVIDER_ID = "gk-bundled";

export const GK_BUNDLED_SKILLS_DIR = path.join(import.meta.dir, "skills");
