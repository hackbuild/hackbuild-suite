// What every example shares: the mount contract and the stand ins that let
// a first visit work with nothing downloaded. The loader moves a progress
// bar and fetches nothing; the samples are drawn in code. Swap stubLoader
// for weightsLoader(store) from @hackbuild/ai-views, or a runtime's own
// loader, to load a real model.
import type { Env } from "@hackbuild/ai-env";
import type { Loader, ModelPick } from "@hackbuild/ai-views";

/** An example draws into a host and hands back how to stop, and the model pick its bar chip shows. */
export interface Example {
  dispose(): void;
  pick?: ModelPick;
}

/** Writes markup into a host and returns its first element. */
export function draw(host: HTMLElement, markup: string): HTMLElement {
  host.innerHTML = markup.trim();
  return host.firstElementChild as HTMLElement;
}

/** A machine with an 8 gb class gpu, as a probe would report it (fixture). */
export const FIXTURE_ENV = {
  webgpu: true,
  f16: true,
  adapter: null,
  maxBufferBytes: null,
  isolated: false,
  protocol: "https",
  opfs: true,
  cacheStorage: true,
  indexedDB: true,
  threads: 1,
  deviceMemoryGB: 8,
  promptApi: false,
} as unknown as Env;

/** Moves the progress to full over about a second; fetches nothing. */
export const stubLoader: Loader = (_rec, ctx) =>
  new Promise((ok, bad) => {
    let f = 0;
    const t = setInterval(() => {
      f = Math.min(1, f + 0.2);
      ctx.onProgress(f);
      if (f >= 1) {
        clearInterval(t);
        ok(undefined);
      }
    }, 180);
    ctx.signal.addEventListener("abort", () => (clearInterval(t), bad(new Error("stopped"))));
  });

/** A stub loader that hands back `value` once the bar is full: an engine, a session. */
export const stubLoaderOf = (value: unknown): Loader => async (rec, ctx) => (await stubLoader(rec, ctx), value);

/** A drawn sample: a red cup and a blue ball on a table, 800 by 600. */
export function sampleCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 800;
  c.height = 600;
  const g = c.getContext("2d")!;
  g.fillStyle = "#efe9db";
  g.fillRect(0, 0, 800, 600);
  g.fillStyle = "#d9d0bd";
  g.fillRect(0, 420, 800, 180);
  g.fillStyle = "#c3251f";
  g.fillRect(330, 260, 140, 150);
  g.fillStyle = "#2f5fa7";
  g.beginPath();
  g.arc(600, 380, 60, 0, Math.PI * 2);
  g.fill();
  return c;
}

/** The things in the sample, in its pixels: what the stub models find. */
export const SAMPLE_THINGS = [
  { label: "cup", score: 0.94, x: 330, y: 260, w: 140, h: 150 },
  { label: "ball", score: 0.81, x: 540, y: 320, w: 120, h: 120 },
];

/** True when a sample pixel is inside a sample thing. */
export function insideThing(t: (typeof SAMPLE_THINGS)[number], x: number, y: number): boolean {
  if (t.label === "ball") return (x - (t.x + t.w / 2)) ** 2 + (y - (t.y + t.h / 2)) ** 2 <= (t.w / 2) ** 2;
  return x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h;
}

/** A 0 or 255 mask over w by h from a pixel test. */
export function maskOf(w: number, h: number, pick: (x: number, y: number) => boolean): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pick(x, y)) m[y * w + x] = 255;
  return m;
}

/** Waits a while; the stubs use it to look like work. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
