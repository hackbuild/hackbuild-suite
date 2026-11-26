// The dog simulator site, and the owner's human body it serves as a plain
// file (dog-simulator pages, with access-control-allow-origin on every
// file, so a cross origin isolated page fetches it in cors mode).
export const DOG = 'https://hackbuild.github.io/dog-simulator/'
export const HUMAN_GLB = `${DOG}assets/human.glb`
/**
 * The dog site the yard loads from: beside the suite on pages (one origin), the
 * public site anywhere else. A single file is never hosted beside it.
 */
export const DOG_SITE = !__SINGLE__ && location.pathname.includes('/hackbuild-suite/') ? new URL('../dog-simulator/', location.href).href : DOG
