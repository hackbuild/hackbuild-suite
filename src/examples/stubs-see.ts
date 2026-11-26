// Stand in runtimes for the see and make examples, under ?stub only: what
// jobLoader would resolve to, written in code and shaped to the sample
// photos (examples/samples). detect finds the cat, masks cut the dog, depth
// is near at the foot with a rise in the middle, vision answers a few
// questions about the cat, image draws stripes from the seed.
import type { Job } from '@hackbuild/ai-views'
import { polygonFill } from '@virgilvox/hackbuild-ui/vanilla'
import type { ExampleDef } from './registry'

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const sizeOf = (img: unknown) => {
  const i = img as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number }
  return { w: i.naturalWidth || i.width || 800, h: i.naturalHeight || i.height || 600 }
}
// the dog of dog.jpg, 800 by 533
const DOG = [
  [315, 112], [392, 79], [467, 67], [500, 138], [529, 171], [470, 203], [550, 162], [612, 238], [588, 275], [521, 279],
  [442, 392], [333, 467], [250, 479], [242, 462], [325, 408], [229, 467], [202, 450], [279, 350], [271, 208], [313, 142],
]
const dogMask = (w: number, h: number) => polygonFill(w, h, DOG.map(([x, y]) => ({ x: (x! * w) / 800, y: (y! * h) / 533 })))

export function runtimeFor(job: Job, _def: ExampleDef): unknown {
  if (job === 'detect') {
    return async (img: unknown) => {
      await wait(80)
      const { w, h } = sizeOf(img)
      return [{ label: 'cat', score: 0.91, x: (210 * w) / 800, y: (270 * h) / 600, w: (320 * w) / 800, h: (300 * h) / 600 }]
    }
  }
  if (job === 'masks') {
    return {
      segment: async (img: { width: number; height: number }) => (await wait(80), dogMask(img.width, img.height)),
      everything: async (img: { width: number; height: number }) => [{ label: 'dog', score: 0.9, mask: dogMask(img.width, img.height) }],
    }
  }
  if (job === 'depth') {
    return async (img: unknown) => {
      await wait(80)
      const { w: iw, h: ih } = sizeOf(img)
      const w = 160
      const h = Math.max(1, Math.round((w * ih) / iw))
      const data = new Float32Array(w * h)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.min(1, 0.6 * (y / h) + 0.4 * Math.exp(-(((x - w / 2) / (w / 5)) ** 2 + ((y - h * 0.6) / (h / 5)) ** 2)))
      return { width: w, height: h, data }
    }
  }
  if (job === 'vision') {
    return async (_img: unknown, q = '') => {
      await wait(120)
      if (/colou?r/.test(q)) return 'stand in answer: orange fur, green leaves, a pale stone wall.'
      if (/how many|count/.test(q)) return 'stand in answer: one cat.'
      if (/where/.test(q)) return 'stand in answer: on the wall, in the middle of the picture.'
      return 'stand in answer: a cat on a wall by a path. no model ran.'
    }
  }
  if (job === 'image') {
    return {
      make: async (o: { seed?: number }) => {
        await wait(120)
        const c = new OffscreenCanvas(512, 512)
        const g = c.getContext('2d')!
        for (let i = 0; i < 8; i++) {
          g.fillStyle = `hsl(${((o.seed ?? 0) * 37 + i * 40) % 360} 40% ${40 + i * 5}%)`
          g.fillRect(0, i * 64, 512, 64)
        }
        return { width: 512, height: 512, rgba: g.getImageData(0, 0, 512, 512).data, seed: o.seed ?? 0 }
      },
    }
  }
  return undefined
}
