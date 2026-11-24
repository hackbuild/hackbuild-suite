// Body files: what a stage takes from a drop or a pick. Twin mode and the
// shared stage toolbar read the same list. A body stays in this tab.
export const BODY_ACCEPT = '.glb,.vrm'

const ext = (name: string) => name.toLowerCase().replace(/^.*\./, '')
/** A glb or vrm, by its name. */
export const isBodyFile = (f: { name: string }): boolean => ext(f.name) === 'glb' || ext(f.name) === 'vrm'
