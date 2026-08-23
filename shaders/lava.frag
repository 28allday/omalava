#version 440

// Omalava -- the glass.
//
// One fragment shader over one quad per monitor. The wax is a metaball field:
// every pixel sums a contribution from each blob slot plus the pool at the
// base, and anything above `threshold` is wax. Nothing is precomputed and
// nothing loops -- blob positions arrive as uniforms from the buoyancy
// simulation (Sim.js via Lamp.qml), which is seeded from the clock every
// start, so two runs never match.
//
// What makes it read as a motion lamp rather than a field of discs:
//   * blobs are ellipses stretched along their velocity, with a longer tail
//     behind them, so rising wax is a teardrop and sinking wax a drip;
//   * a wide elliptical pool of wax sits on the heater, and blobs merge into
//     and pinch off from it through the field;
//   * the wax is lit from the bulb below: bright where it is thin and low,
//     deep and saturated where it is thick, shaded with a fake normal from the
//     field gradient, with a soft translucent edge and a glossy highlight;
//   * the liquid is lit from below too -- a warm bulb glow at the base fading
//     to a dark cap.
//
// Unused blob slots carry a zero radius and contribute nothing.
//
// Rebuild after editing:  shaders/bake.sh

layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;

layout(std140, binding = 0) uniform buf {
    mat4  qt_Matrix;
    float qt_Opacity;

    float aspect;       // width / height of the surface
    float threshold;    // field level that counts as wax (1.0 = blob radius)
    float glow;         // halo strength around the wax, 0..1
    float heater;       // bulb strength, 0..1
    float wobble;       // edge ripple amplitude
    float time;         // seconds, for the ripple phase

    vec4 bgTop;         // liquid at the cap
    vec4 bgBottom;      // liquid at the base, by the bulb
    vec4 edgeColor;     // thin, backlit wax
    vec4 coreColor;     // thick wax
    vec4 hotColor;      // the bulb
    vec4 glowColor;     // halo in the liquid

    vec4 pool;          // x = centre x, y = half-width, z = height, w = breathing 0..1

    // xy = position in lamp space (x in 0..aspect, y in 0..1, y up)
    // z  = radius, w = vertical velocity the SHAPE has relaxed to (lamp heights/s)
    vec4 b0;  vec4 b1;  vec4 b2;  vec4 b3;
    vec4 b4;  vec4 b5;  vec4 b6;  vec4 b7;
    vec4 b8;  vec4 b9;  vec4 b10; vec4 b11;

    // Stalks, one per blob: x = where the column meets the pool, y = strength
    // 0..1 (0 = no column), zw unused.
    vec4 s0;  vec4 s1;  vec4 s2;  vec4 s3;
    vec4 s4;  vec4 s5;  vec4 s6;  vec4 s7;
    vec4 s8;  vec4 s9;  vec4 s10; vec4 s11;
};

// Field contribution of one blob, with its analytic gradient (xy) so the
// shading normal is smooth instead of screen-space-derivative noise.
//
// An ellipse stretched along its motion -- the faster it moves the taller it
// is, and the half behind it is longer still, which is what gives rising wax
// its teardrop and a drip its tail. A slow three-lobed ripple keeps the
// outline from ever being a clean curve. The falloff is (r^2/d^2)^2 rather
// than the textbook r^2/d^2: steeper, so blobs stay distinct until they are
// genuinely close, then neck and split.
vec4 blob(vec2 p, vec4 b, float k) {
    vec2 d = p - b.xy;
    float vy = b.w;
    float speed = clamp(abs(vy) * 14.0, 0.0, 1.0);
    float sy = 1.15 + 0.9 * speed;                      // taller when moving
    float behind = step(0.0, -d.y * sign(vy + 1e-6));    // 1 on the trailing side
    sy *= 1.0 + 0.5 * speed * behind;                    // the tail is longer
    float a = atan(d.y, d.x);
    float r = b.z * (1.0 + wobble * sin(3.0 * a + k * 2.4 + time * 0.5)
                         + wobble * 0.5 * sin(5.0 * a - k * 1.7 - time * 0.3));
    float dy = d.y / sy;
    float dd = d.x * d.x + dy * dy + 1e-6;
    float r2 = r * r;
    float f = (r2 * r2) / (dd * dd);
    // d f / d p  (ripple treated as constant -- it is small)
    vec2 g = -4.0 * f / dd * vec2(d.x, dy / sy);
    return vec4(f, g, f * f * r);
}

// The stalk: a column of wax from the pool up to a blob that has just lifted
// off, so the wax visibly extrudes from the base and pinches off. A capsule
// metaball along the segment from the launch point to just under the blob.
//   s.x = launch x
//   s.y = 0: no column; 0..1: fading in as the blob clears the pool;
//         >= 1: full column with a neck of depth (s.y - 1). The neck cuts at
//         ~0.83 and KEEPS deepening after the break: that is how the gap opens,
//         the lower piece receding into the pool and the upper into the blob,
//         with no change of geometry at the instant of the break.
//   s.zw = where the column's top was when it broke (z = 0: still connected)
//
// `tA..tB` say which stretch of the full column this capsule is, so the
// width profile and the notch line up across pieces.
vec4 capsule(vec2 p, vec2 A, vec2 B, float wA, float wB, float notch, float tA, float tB) {
    vec2 AB = B - A;
    float len2 = max(dot(AB, AB), 1e-6);
    float t = clamp(dot(p - A, AB) / len2, 0.0, 1.0);
    float tc = mix(tA, tB, t);                          // position on the full column
    vec2 d = p - (A + AB * t);
    // The pinch is a NECK, not a uniform thinning: a notch deepens around
    // tc = 0.7 until the column is cut there, the way a Rayleigh-Plateau neck
    // breaks, and goes on widening after. A uniform thinning leaves a
    // hairline thread before the snap.
    float neck = 1.0 - 1.2 * notch * exp(-pow((tc - 0.7) / 0.2, 2.0));
    float w = mix(wA, wB, tc) * (1.0 + 0.06 * sin(tc * 14.0 - time * 1.3)) * max(neck, 0.0);
    if (w <= 1e-4) return vec4(0.0);
    // Bounded core (no singular axis): same radius at threshold, finite at
    // the centre, so the shading normal does not crease down the middle.
    float w2 = w * w;
    float dd = dot(d, d) + 0.3 * w2;
    float q = 1.3 * w2 / dd;
    float f = q * q;
    vec2 g = -4.0 * f / dd * d;
    return vec4(f, g, f * f * w);
}

vec4 stalk(vec2 p, vec4 b, vec4 s) {
    if (b.z <= 0.0 || s.y <= 0.001) return vec4(0.0);
    float vis = min(s.y, 1.0);
    float notch = max(s.y - 1.0, 0.0);
    vec2 A = vec2(s.x, 0.0);
    vec2 B = b.xy - vec2(0.0, b.z * 0.35);
    float wA = b.z * 0.78 * vis, wB = b.z * 0.52 * vis;
    if (s.z <= 0.001) {
        // Connected: one column from the pool to under the blob.
        return capsule(p, A, B, wA, wB, notch, 0.0, 1.0);
    }
    // Broken. The gap has half-width `band` (in column-t units) either side
    // of the neck. The lower piece stays where the column was, anchored on
    // the pool, and fattens a little as it shortens; the upper piece is the
    // top of the column, carried along under the blob. Right at the break
    // the ends are the needle points the notch left; surface tension rounds
    // them within the first hair of gap (curvature is highest there), so the
    // tapered notch fades out and the capsules' own rounded ends take over.
    vec2 Bf = vec2(s.w, s.z);
    float band = 0.2 * sqrt(max(log(1.2 * notch), 0.0));
    float rounded = smoothstep(0.0, 0.06, band);
    float taper = notch * (1.0 - rounded);
    float fat = 1.0 + 0.5 * clamp(band / 0.5, 0.0, 1.0);
    vec4 out_ = vec4(0.0);
    float tLow = 0.7 - band;
    if (tLow > 0.02) {
        // The last of the stump flattens into the pool: its width eases to
        // nothing as its length does, so the final stub never pokes above
        // the surface and then vanishes.
        float ease = smoothstep(0.02, 0.18, tLow);
        vec2 E = A + (Bf - A) * tLow;
        out_ += capsule(p, A, E, wA * fat * ease, wB * fat * ease, taper, 0.0, tLow);
    }
    float tUp = 0.7 + band;
    if (tUp < 0.98) {
        // The remnant is absorbed: it shortens, and its width eases to nothing
        // over the last stretch rather than vanishing with a bulge intact.
        float ease = smoothstep(0.98, 0.85, tUp);
        vec2 Q = B - (Bf - A) * (1.0 - tUp);
        out_ += capsule(p, Q, B, wA * ease, wB * ease, taper, tUp, 1.0);
    }
    return out_;
}

// The pool: wax across the whole base of the glass, sitting on the heater,
// its surface slowly undulating. A slab metaball: a horizontal line at depth
// R below the surface, with everything beneath it solid wax.
//   pool.z = nominal surface height, pool.w unused
float poolSurface(float x, out float slope) {
    float H = pool.z;
    float a = 1.7, b = 3.9, c = 8.1;
    float sa = sin(a * x + time * 0.19), sb = sin(b * x - time * 0.27 + 1.0), sc = sin(c * x + time * 0.43 + 2.0);
    float ca = cos(a * x + time * 0.19), cb = cos(b * x - time * 0.27 + 1.0), cc = cos(c * x + time * 0.43 + 2.0);
    slope = H * (0.18 * a * ca + 0.12 * b * cb + 0.05 * c * cc);
    return H * (1.0 + 0.18 * sa + 0.12 * sb + 0.05 * sc);
}
vec4 poolField(vec2 p) {
    float slope;
    float h = poolSurface(p.x, slope);
    float R = pool.z * 1.2;
    float dy = p.y - (h - R);
    if (dy <= 1e-4) dy = 1e-4;                 // below the line: solid wax
    float R2 = R * R;
    float f = (R2 * R2) / (dy * dy * dy * dy);
    vec2 g = vec2(4.0 * f / dy * slope, -4.0 * f / dy);
    return vec4(f, g, f * f * R);
}

// Sum of every primitive: x = field, yz = gradient, w = sum(f^2 * r). f2 out
// is sum(f^2), so w / f2 is the radius of the wax this pixel belongs to,
// weighted so the dominant feature wins -- a column hidden inside a mound
// must not tint the mound with its own thinness.
vec4 field(vec2 p, out float f2) {
    vec4 acc = vec4(0.0); f2 = 0.0;
    vec4 c;
    c = poolField(p);          acc += c; f2 += c.x * c.x;
    c = blob(p, b0, 0.0);      acc += c; f2 += c.x * c.x;
    c = blob(p, b1, 1.0);      acc += c; f2 += c.x * c.x;
    c = blob(p, b2, 2.0);      acc += c; f2 += c.x * c.x;
    c = blob(p, b3, 3.0);      acc += c; f2 += c.x * c.x;
    c = blob(p, b4, 4.0);      acc += c; f2 += c.x * c.x;
    c = blob(p, b5, 5.0);      acc += c; f2 += c.x * c.x;
    c = blob(p, b6, 6.0);      acc += c; f2 += c.x * c.x;
    c = blob(p, b7, 7.0);      acc += c; f2 += c.x * c.x;
    c = blob(p, b8, 8.0);      acc += c; f2 += c.x * c.x;
    c = blob(p, b9, 9.0);      acc += c; f2 += c.x * c.x;
    c = blob(p, b10, 10.0);    acc += c; f2 += c.x * c.x;
    c = blob(p, b11, 11.0);    acc += c; f2 += c.x * c.x;
    c = stalk(p, b0, s0);      acc += c; f2 += c.x * c.x;
    c = stalk(p, b1, s1);      acc += c; f2 += c.x * c.x;
    c = stalk(p, b2, s2);      acc += c; f2 += c.x * c.x;
    c = stalk(p, b3, s3);      acc += c; f2 += c.x * c.x;
    c = stalk(p, b4, s4);      acc += c; f2 += c.x * c.x;
    c = stalk(p, b5, s5);      acc += c; f2 += c.x * c.x;
    c = stalk(p, b6, s6);      acc += c; f2 += c.x * c.x;
    c = stalk(p, b7, s7);      acc += c; f2 += c.x * c.x;
    c = stalk(p, b8, s8);      acc += c; f2 += c.x * c.x;
    c = stalk(p, b9, s9);      acc += c; f2 += c.x * c.x;
    c = stalk(p, b10, s10);    acc += c; f2 += c.x * c.x;
    c = stalk(p, b11, s11);    acc += c; f2 += c.x * c.x;
    return acc;
}

void main() {
    // Lamp space: x spans 0..aspect, y is 0 at the base and 1 at the cap.
    vec2 p = vec2(qt_TexCoord0.x * aspect, 1.0 - qt_TexCoord0.y);

    float f2;
    vec4 fg = field(p, f2);
    float f = fg.x;
    // Size of the wax feature this pixel belongs to (see field()).
    float rLocal = fg.w / max(f2, 1e-12);

    // ---- the liquid ------------------------------------------------------
    // Dark at the cap, lit at the base, with the bulb glowing through it.
    vec3 liquid = mix(bgBottom.rgb, bgTop.rgb, smoothstep(0.0, 1.0, p.y));
    // The heater runs the whole width of the base, evenly, so its glow is a
    // band along the bottom, not a spot under the middle.
    float bulbGlow = exp(-p.y * p.y * 14.0) * heater;
    liquid += hotColor.rgb * bulbGlow * 0.5;
    float side = abs(qt_TexCoord0.x - 0.5) * 2.0;
    liquid *= 1.0 - 0.22 * side * side;

    // Halo: wax just below the threshold still lights the liquid around it,
    // which is what makes two approaching blobs look like they are pulling at
    // each other before they touch.
    float halo = clamp(f / threshold, 0.0, 1.0);
    halo = halo * halo * halo * halo;
    vec3 color = liquid + glowColor.rgb * halo * glow * 0.35;

    // ---- the wax ---------------------------------------------------------
    // Outward normal: the field rises toward the inside, so minus the gradient.
    float gl = length(fg.yz);
    vec2 n = gl > 1e-9 ? -fg.yz / gl : vec2(0.0, 1.0);

    // Where are we inside the wax? rho = (threshold/f)^0.25 is the distance
    // to the centre of the local feature as a fraction of its radius (for a
    // lone blob the field is (r/d)^4, so this is exactly d/r): 1 at the skin,
    // 0 at the centre. It shapes the normal. Colour comes from ABSOLUTE
    // thickness, rho scaled by the local feature size -- a thin stalk is as
    // "deep" at its axis as a fat blob is at its centre, and a relative
    // measure paints a line down the middle of every column, where real wax
    // that thin is bright and backlit.
    float rho = clamp(pow(threshold / max(f, 1e-6), 0.25), 0.0, 1.0);
    float depth = 1.0 - rho;
    float thick = rLocal * depth;
    float body = smoothstep(0.0, 0.15, thick);
    body = 0.3 + 0.7 * body * body;

    // Wax is lit from the bulb below: thin and low glows, thick and high is
    // deep and saturated. The skin is a blend, never the bare bright colour.
    float backlight = exp(-p.y * 1.6) * (0.5 + 0.5 * heater);
    vec3 wax = mix(edgeColor.rgb, coreColor.rgb, body);
    wax = mix(wax, edgeColor.rgb, 0.3 * backlight * (1.0 - 0.6 * depth));
    wax = mix(wax, hotColor.rgb, bulbGlow * 0.5);

    // A sphere normal: rho is exactly a ball's radius fraction, so this is a
    // ball's normal -- horizontal at the skin, facing the viewer at the
    // centre. (A z-component linear in rho instead leaves the highlight
    // strong along the whole ray toward the light and draws a streak from
    // the centre; the sphere confines it to a spot.)
    // Where two blobs merge the gradients cancel at the saddle and the 2D
    // normal flips sign across it, which the lighting draws as a seam. For a
    // lone feature at this rho the gradient magnitude would be 4f/(rho*r);
    // the ratio of the real magnitude to that is 1 on a clean skin and 0 at
    // a saddle, so scaling the normal's tilt by it lays the seam flat --
    // merged wax reads as one smooth surface, as surface tension makes it.
    float expectG = 4.0 * f / max(rho * rLocal, 1e-5);
    float tilt = rho * clamp(gl / expectG, 0.0, 1.0);
    vec3 n3 = normalize(vec3(n * tilt, sqrt(max(0.0, 1.0 - tilt * tilt))));
    // Lit from the bulb below and slightly in front: faces looking down are
    // brighter, faces looking up fall into shade. A soft gloss from above-left.
    float diffuse = 0.78 + 0.22 * clamp(dot(n3, normalize(vec3(0.0, -1.0, 0.45))), 0.0, 1.0);
    float gloss = pow(max(0.0, dot(n3, normalize(vec3(-0.4, 0.75, 0.55)))), 14.0);
    wax *= diffuse;
    wax += edgeColor.rgb * gloss * 0.28;

    // The surface: soft, antialiased by the field's screen-space slope,
    // clamped so the singular centre cannot punch a hole in the wax.
    float aa = clamp(fwidth(f), 1e-4, threshold * 0.35);
    float inside = smoothstep(threshold - aa, threshold + aa, f);
    // A faint bright skin where light passes through the thin edge.
    float skin = smoothstep(threshold, threshold * 1.6, f) * (1.0 - smoothstep(threshold * 1.6, threshold * 4.0, f));
    wax += edgeColor.rgb * skin * 0.12 * (0.4 + 0.6 * backlight);

    color = mix(color, wax, inside);
    fragColor = vec4(color, 1.0) * qt_Opacity;
}
