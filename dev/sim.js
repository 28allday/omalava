#!/usr/bin/env node
// Headless check of the wax dynamics: runs Sim.js under node and prints each
// blob's height and heat over time, plus the spread of heights at the end.
//   node dev/sim.js [blobs=7] [seconds=300] [aspect=1.78]
const fs = require("fs"), path = require("path"), vm = require("vm")
const src = fs.readFileSync(path.join(__dirname, "..", "Sim.js"), "utf8").replace(/^\.pragma library\s*/, "")
const ctx = { Math, console }
vm.createContext(ctx)
vm.runInContext(src + "\nthis.Sim = { newBlob, step, rescale, rescaleX, clampToAspect, MAX_BLOBS }", ctx)
const Sim = ctx.Sim
const n = Number(process.argv[2] || 7), secs = Number(process.argv[3] || 300), aspect = Number(process.argv[4] || 1.78)
const blobs = []
for (let i = 0; i < n; i++) blobs.push(Sim.newBlob(aspect, 1.0, false))
const env = { aspect, heater: 0.8, time: 0, poolTop: 0.13 }
const h = 1 / 30
let t = 0, next = 0
const hist = { base: 0, mid: 0, top: 0, samples: 0 }
while (t < secs) {
  env.time = t; Sim.step(blobs, h, env); t += h
  if (t >= next) {
    next += 15
    console.log("t=" + t.toFixed(0).padStart(4) + "  " + blobs.map(b => `y${b.y.toFixed(2)}/h${(b.heat >= 0 ? "+" : "") + b.heat.toFixed(1)}`).join(" "))
  }
  if (t > 60) for (const b of blobs) { hist.samples++; if (b.y < 0.3) hist.base++; else if (b.y < 0.7) hist.mid++; else hist.top++ }
}
const pct = k => (100 * hist[k] / hist.samples).toFixed(0) + "%"
console.log(`height share after 60s: base ${pct("base")}  mid ${pct("mid")}  top ${pct("top")}`)
for (const b of blobs) if (!isFinite(b.x + b.y + b.heat)) { console.error("NaN blob"); process.exit(1) }
