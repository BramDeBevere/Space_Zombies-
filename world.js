// World — renderer, scene, camera, lights and the night arena.
import * as THREE from 'three';

// --- Tunable constants (arena / player) ---
export const ARENA_HALF = 60;          // arena is [-60, 60] on X and Z
const WALL_HEIGHT = 5;
export const EYE_HEIGHT = 1.7;         // camera height above the player's feet
export const PLAYER_RADIUS = 0.6;

// Top-down colliders that block the player and the zombies. Filled by the
// crate / streetlight / watchtower / building blocks below.
//   circle: { x, z, r }
//   box:    { x, z, halfX, halfZ, box: true }
export const obstacles = [];

// Climbable watchtowers. Each exposes a ground-level collider that blocks the
// player when they're on the ground (so they can't walk through the base), and
// a higher deck collider that blocks them while they're on top (so they can't
// fall straight through the floor). The player climbs between them (see the
// `climbing` state in player.js).
export const towers = [];

// --- Renderer ---
const app = document.getElementById('app');
export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.7;
app.appendChild(renderer.domElement);

// --- Scene ---
export const scene = new THREE.Scene();
scene.background = null; // the sky is a fixed world-anchored dome (see below)
scene.fog = new THREE.FogExp2(0x2a3852, 0.0072); // a bit thinner so the bigger arena stays readable

// The sky dome follows the camera's position (translation only) so the player
// always stays centred inside it; its orientation never changes, which keeps
// the stars and moon locked to fixed world directions.
export let skyDome = null;

// --- Camera ---
export const camera = new THREE.PerspectiveCamera(
  72, window.innerWidth / window.innerHeight, 0.1, 500
);
camera.position.set(0, EYE_HEIGHT, 0);

// --- Fixed sky dome (equirectangular, generated, no asset file) ---
// World-anchored (not a child of the camera) so the stars and moon stay in
// fixed directions in space instead of gluing to the view. Made very large so
// walking around the arena produces negligible parallax.
{
  const SKY_RADIUS = 350;
  skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 32, 24),
    new THREE.MeshBasicMaterial({
      map: makeSkyTexture(),
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      toneMapped: false, // keep the sky at the brightness we authored it
    })
  );
  scene.add(skyDome);
}

// --- Moonlight (single cool directional + soft hemisphere fill) ---
scene.add(new THREE.HemisphereLight(0x6b80a8, 0x242e42, 1.8));
const moon = new THREE.DirectionalLight(0xb6d0ff, 2.7);
moon.position.set(-30, 50, 20);
moon.castShadow = true;
moon.shadow.mapSize.set(1024, 1024);
moon.shadow.camera.near = 1;
moon.shadow.camera.far = 140;
moon.shadow.camera.left = -ARENA_HALF;
moon.shadow.camera.right = ARENA_HALF;
moon.shadow.camera.top = ARENA_HALF;
moon.shadow.camera.bottom = -ARENA_HALF;
moon.shadow.bias = -0.0008;
scene.add(moon);
scene.add(moon.target);

// --- Arena floor (generated grid texture — no external assets) ---
{
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  const base = ctx.createLinearGradient(0, 0, 0, size);
  base.addColorStop(0, '#3b4859');
  base.addColorStop(1, '#2c3745');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // faint speckle for texture
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const s = Math.random() * 2;
    ctx.fillStyle = `rgba(${255 + Math.floor(Math.random() * 40)},${255 + Math.floor(Math.random() * 40)},255,${Math.random() * 0.05})`;
    ctx.fillRect(x, y, s, s);
  }

  ctx.strokeStyle = 'rgba(150,180,220,0.16)';
  ctx.lineWidth = 2;
  const step = size / 16;
  for (let i = 0; i <= 16; i++) {
    const p = i * step;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(p, size); ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(ARENA_HALF / 7, ARENA_HALF / 7); // keep the grid tiles the same physical size
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2),
    new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.92, metalness: 0.0,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
}

// --- Arena walls (one ring of 4 boxes) + crates to break up the space ---
{
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x58687e, roughness: 0.8, metalness: 0.1,
  });
  const wallGeo = new THREE.BoxGeometry(ARENA_HALF * 2, WALL_HEIGHT, 1);

  const walls = [
    { pos: [0, WALL_HEIGHT / 2, -ARENA_HALF], rot: 0 },
    { pos: [0, WALL_HEIGHT / 2, ARENA_HALF], rot: 0 },
    { pos: [-ARENA_HALF, WALL_HEIGHT / 2, 0], rot: Math.PI / 2 },
    { pos: [ARENA_HALF, WALL_HEIGHT / 2, 0], rot: Math.PI / 2 },
  ];
  for (const w of walls) {
    const m = new THREE.Mesh(wallGeo, wallMat);
    m.position.set(...w.pos);
    m.rotation.y = w.rot;
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }

  // A few low crates — each also blocks the player (circular collider).
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x6a5e4a, roughness: 0.9 });
  const cratePositions = [
    // original cluster
    [-14, -10], [18, 6], [-6, 22], [10, -24], [-26, 14], [24, 24],
    // extra cover spread across the larger arena
    [-40, -32], [44, -18], [34, 40], [-38, 34], [2, -46], [50, 12], [-22, -44],
  ];
  const CRATE_COLLIDE = 1.65; // circumscribed radius of the 2x2 face, so rotation is covered
  for (const [x, z] of cratePositions) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), crateMat);
    crate.position.set(x, 1, z);
    crate.rotation.y = Math.random() * Math.PI;
    crate.castShadow = true;
    crate.receiveShadow = true;
    scene.add(crate);
    obstacles.push({ x, z, r: CRATE_COLLIDE });
  }
}

// --- Ring of dim "street lights" for atmosphere (no real lighting cost) ---
{
  const postMat = new THREE.MeshStandardMaterial({ color: 0x2b333f, roughness: 0.7 });
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0x11131a, emissive: 0xffcf87, emissiveIntensity: 3.4,
  });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.cos(a) * (ARENA_HALF - 3);
    const z = Math.sin(a) * (ARENA_HALF - 3);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, 6, 8), postMat);
    post.position.set(x, 3, z);
    post.castShadow = true;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 12), bulbMat);
    bulb.position.set(x, 6, z);
    scene.add(post, bulb);
    obstacles.push({ x, z, r: 0.4 });
  }
}

// --- A watchtower landmark: support posts, a raised deck, railings and a roof ---
// Placed off-center so it doesn't sit on the spawn point, but close enough to be
// a focal point. The whole footprint blocks movement (one circular collider)
// and the ladder auto-orients toward the arena centre, so any (x, z) works.
function buildWatchtower(tx, tz) {
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a4630, roughness: 0.85 });
  const darkWoodMat = new THREE.MeshStandardMaterial({ color: 0x40321f, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.7, metalness: 0.15 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x2b333f, roughness: 0.7 });

  const half = 3.0;        // half-width of the tower frame
  const deckY = 7.6;       // height of the raised lookout deck (taller than before)

  // A thin straight/diagonal member between two points (posts + lattice bracing).
  const _up = new THREE.Vector3(0, 1, 0);
  function beam(ax, ay, az, bx, by, bz, radius, mat) {
    const a = new THREE.Vector3(ax, ay, az);
    const b = new THREE.Vector3(bx, by, bz);
    const dir = new THREE.Vector3().subVectors(b, a);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, dir.length(), 8), mat);
    m.position.copy(a).addScaledVector(dir, 0.5);
    m.quaternion.setFromUnitVectors(_up, dir.clone().normalize());
    m.castShadow = true;
    scene.add(m);
    return m;
  }

  // Four corner columns, from the ground up to the deck.
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const px = corners.map(([sx, sz]) => [tx + sx * half, tz + sz * half]);
  px.forEach(([cx, cz]) => beam(cx, 0, cz, cx, deckY, cz, 0.26, woodMat));

  // Lattice X-bracing plus horizontal ties on every face — the lookout look.
  for (let i = 0; i < 4; i++) {
    const [ax, az] = px[i];
    const [bx, bz] = px[(i + 1) % 4];
    beam(ax, 0, az, bx, deckY, bz, 0.09, darkWoodMat);
    beam(bx, 0, bz, ax, deckY, az, 0.09, darkWoodMat);
    for (const fy of [0.34, 0.68]) {
      const y = deckY * fy;
      beam(ax, y, az, bx, y, bz, 0.08, darkWoodMat);
    }
  }

  // The raised lookout deck you can walk out on.
  const deck = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 0.8, 0.4, half * 2 + 0.8), woodMat);
  deck.position.set(tx, deckY, tz);
  deck.castShadow = deck.receiveShadow = true;
  scene.add(deck);

  // Cabin: railing posts + a flat, overhanging roof (open on all four sides).
  // The cabin is roomy — clear height well above standing eye level — so the
  // lookout feels like an open cabin you can stand in, not a cramped box.
  const cabinHalf = half + 0.3;
  const cabinH = 2.7;       // clear height from the deck floor up to the roof
  const roofY = deckY + cabinH;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      beam(tx + sx * cabinHalf, deckY, tz + sz * cabinHalf,
           tx + sx * cabinHalf, roofY, tz + sz * cabinHalf, 0.1, woodMat);
    }
  }
  // A low rail, a mid rail and a top rail around each side.
  for (const rr of [1.0, 1.8, cabinH]) {
    const ry = deckY + rr;
    beam(tx - cabinHalf, ry, tz - cabinHalf, tx + cabinHalf, ry, tz - cabinHalf, 0.06, railMat);
    beam(tx + cabinHalf, ry, tz - cabinHalf, tx + cabinHalf, ry, tz + cabinHalf, 0.06, railMat);
    beam(tx + cabinHalf, ry, tz + cabinHalf, tx - cabinHalf, ry, tz + cabinHalf, 0.06, railMat);
    beam(tx - cabinHalf, ry, tz + cabinHalf, tx - cabinHalf, ry, tz - cabinHalf, 0.06, railMat);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(cabinHalf * 2 + 0.6, 0.28, cabinHalf * 2 + 0.6), roofMat);
  roof.position.set(tx, roofY + 0.14, tz);
  roof.castShadow = roof.receiveShadow = true;
  scene.add(roof);

  // A warm beacon floating just above the roof, echoing the streetlights.
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0x11131a, emissive: 0xffcf87, emissiveIntensity: 3.4,
  });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 12), bulbMat);
  beacon.position.set(tx, roofY + 1.1, tz);
  scene.add(beacon);

  // A straight external staircase up the arena-facing side to the deck (press E
  // to climb): a sloped stringer, treads and two handrails. It runs from the
  // ground (footR) up to the deck (topR), leaning inward, along the same straight
  // centreline the player slides up while climbing.
  const baseR = Math.hypot(half, half);   // circle collider that clears the corners
  const toCenter = new THREE.Vector2(0 - tx, 0 - tz);
  const tcLen = Math.hypot(toCenter.x, toCenter.y) || 1;
  const ux = toCenter.x / tcLen, uz = toCenter.y / tcLen;   // unit, toward arena centre
  const deckTopY = deckY + 0.2;   // top of the deck slab where the player stands
  const walkR = half + 0.3;       // max distance from the centre on the deck
  const footR = baseR + PLAYER_RADIUS; // stair foot radius (ground reach)
  const topR = half;              // stair top radius (on the deck)
  {
    const basePt = new THREE.Vector3(tx + ux * footR, 0, tz + uz * footR);
    const topPt = new THREE.Vector3(tx + ux * topR, deckTopY, tz + uz * topR);
    const dir = new THREE.Vector3().subVectors(topPt, basePt);
    const len = dir.length();
    const stair = new THREE.Group();
    const stringer = new THREE.Mesh(new THREE.BoxGeometry(0.62, len, 0.14), darkWoodMat);
    stringer.position.set(0, len / 2, 0);
    stair.add(stringer);
    const N = Math.max(6, Math.round(deckTopY / 0.4));
    for (let i = 1; i <= N; i++) {
      const tread = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.09, 0.44), woodMat);
      tread.position.set(0, (len / N) * i, 0.04);
      stair.add(tread);
    }
    for (const sx of [-0.34, 0.34]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, len * 1.03, 0.06), railMat);
      rail.position.set(sx, len / 2 + 0.5, 0.04);
      stair.add(rail);
      for (const fy of [0.12, 0.5, 0.88]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.05), railMat);
        post.position.set(sx, len * fy, 0.04);
        stair.add(post);
      }
    }
    stair.position.copy(basePt);
    stair.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    scene.add(stair);
  }

  // The base blocks ground movement; the deck (climbed) is a separate surface.
  obstacles.push({ x: tx, z: tz, r: baseR });
  towers.push({
    x: tx, z: tz,
    deckTop: deckTopY,  // top of the deck slab where the player stands
    walkR,              // max distance from the centre on the deck (railings)
    footR,              // stair foot radius (where the climb starts, on the ground)
    topR,               // stair top radius (where the climb ends, on the deck)
    baseR,              // radius of the base collider
    ux, uz,             // unit direction from the centre toward the stairs
  });
}
// The original watchtower plus two more, spread around the arena (all far from
// the spawn at the centre, the building at [30,-22], and the crate/streetlight
// positions, so each keeps its own open footprint and clear ladder run-up).
buildWatchtower(-20, 40);   // original (north-west)
buildWatchtower(42, 34);    // north-east
buildWatchtower(24, -44);   // south-east

// A "working" light bulb: an emissive glass bulb with a small metal socket and
// a hanging wire, plus a real PointLight at the same spot so it genuinely
// illuminates the scene (not just glowing). Reusable on any structure.
function addBulbLight(x, y, z, radius = 22, intensity = 26) {
  const glass = new THREE.MeshStandardMaterial({
    color: 0x3a2e1a, emissive: 0xffd794, emissiveIntensity: 4.5, roughness: 0.3,
  });
  const metal = new THREE.MeshStandardMaterial({ color: 0x2b303a, roughness: 0.5, metalness: 0.6 });
  const g = new THREE.Group();
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 16), glass);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.16, 12), metal);
  base.position.y = 0.28;                       // screw socket on top of the glass
  const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.6, 6), metal);
  wire.position.y = 0.65;                       // drops from a mount above
  g.add(sphere, base, wire);
  g.position.set(x, y, z);
  scene.add(g);
  const light = new THREE.PointLight(0xffd9a0, intensity, radius, 2);
  light.position.set(x, y, z);
  scene.add(light);
  return light;
}

// --- A building: four solid brick walls, lit windows and a flat roof ---
// Placed in the opposite corner from the watchtower. The whole footprint is a
// single box collider, so the player and zombies slide around it as cover.
{
  const [bx, bz] = [30, -22];
  const bw = 7, bd = 6;        // half-widths of the footprint
  const H = 6, T = 0.5;        // wall height and thickness
  const brick = new THREE.MeshStandardMaterial({ color: 0x6e5245, roughness: 0.9 });
  const roofM = new THREE.MeshStandardMaterial({ color: 0x46362b, roughness: 0.7 });
  const winM  = new THREE.MeshStandardMaterial({ color: 0x241c12, emissive: 0xffc079, emissiveIntensity: 1.6 });

  // Four walls with a doorway cut into the centre-facing (north) side, so the
  // building can actually be entered. The gap is left open in the collider too
  // (see below) so the player and zombies can walk in and out.
  const north = bz + bd;  // centre-facing side
  const doorW = 2.2;      // width of the doorway
  const doorH = 2.4;      // height of the doorway
  const segW = bw - doorW / 2;
  const nLeft = new THREE.Mesh(new THREE.BoxGeometry(segW, H, T), brick);
  nLeft.position.set(bx - (doorW / 2 + segW / 2), H / 2, north);
  const nRight = new THREE.Mesh(new THREE.BoxGeometry(segW, H, T), brick);
  nRight.position.set(bx + (doorW / 2 + segW / 2), H / 2, north);
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorW, H - doorH, T), brick);
  lintel.position.set(bx, doorH + (H - doorH) / 2, north);
  const south = new THREE.Mesh(new THREE.BoxGeometry(bw * 2, H, T), brick);
  south.position.set(bx, H / 2, bz - bd);
  const west = new THREE.Mesh(new THREE.BoxGeometry(T, H, bd * 2), brick);
  west.position.set(bx - bw, H / 2, bz);
  const east = new THREE.Mesh(new THREE.BoxGeometry(T, H, bd * 2), brick);
  east.position.set(bx + bw, H / 2, bz);
  [nLeft, nRight, lintel, south, west, east].forEach((m) => {
    m.castShadow = m.receiveShadow = true; scene.add(m);
  });
  // A slim door frame around the opening (visual only — it doesn't block you).
  const frameM = new THREE.MeshStandardMaterial({ color: 0x3a2f22, roughness: 0.9 });
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, doorH, T + 0.1), frameM);
    post.position.set(bx + sx * (doorW / 2), doorH / 2, north);
    scene.add(post);
  }

  // Lit windows on the outer faces.
  const winW = new THREE.Mesh(new THREE.BoxGeometry(T * 0.5, 2, 3), winM);
  winW.position.set(bx - bw - T * 0.2, 3.5, bz);
  const winS = new THREE.Mesh(new THREE.BoxGeometry(3, 2, T * 0.5), winM);
  winS.position.set(bx, 3.5, bz - bd - T * 0.2);
  const winE = new THREE.Mesh(new THREE.BoxGeometry(T * 0.5, 2, 3), winM);
  winE.position.set(bx + bw + T * 0.2, 3.5, bz);
  scene.add(winW, winS, winE);

  // Flat roof slab + a small rooftop unit for interest.
  const roof = new THREE.Mesh(new THREE.BoxGeometry(bw * 2 + 0.8, 0.4, bd * 2 + 0.8), roofM);
  roof.position.set(bx, H + 0.2, bz);
  roof.castShadow = roof.receiveShadow = true;
  scene.add(roof);
  const unit = new THREE.Mesh(
    new THREE.BoxGeometry(2, 1, 1.5),
    new THREE.MeshStandardMaterial({ color: 0x555f6a, roughness: 0.6 })
  );
  unit.position.set(bx - 2, H + 0.9, bz - 2);
  scene.add(unit);

  // A working bulb hanging on the centre-facing wall, a little off the brick, so
  // it casts a warm pool of light onto the open area in front of the building.
  addBulbLight(bx, H - 1.8, north + T * 0.5 + 0.6);
  // Two bulbs inside so the (now enterable) interior isn't pitch dark.
  addBulbLight(bx, H - 1.0, bz - 1.5, 12, 18);
  addBulbLight(bx, H - 1.0, bz + 3.5, 12, 18);

  // Colliders: solid walls with the doorway left open, so the building can be
  // entered but you still can't walk through the brick. Small overlaps at the
  // corners seal the gaps between the wall segments.
  const dh = doorW / 2;                       // half the doorway width
  obstacles.push({ x: bx - (dh + (bw - dh) / 2), z: north, halfX: (bw - dh) / 2, halfZ: T / 2 + 0.2, box: true });
  obstacles.push({ x: bx + (dh + (bw - dh) / 2), z: north, halfX: (bw - dh) / 2, halfZ: T / 2 + 0.2, box: true });
  obstacles.push({ x: bx, z: bz - bd, halfX: bw + 0.2, halfZ: T / 2 + 0.2, box: true });
  obstacles.push({ x: bx - bw, z: bz, halfX: T / 2 + 0.2, halfZ: bd + 0.2, box: true });
  obstacles.push({ x: bx + bw, z: bz, halfX: T / 2 + 0.2, halfZ: bd + 0.2, box: true });
}

// --- Extra cover: barrels, a low wall and a few more crates to hide behind ---
{
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x5b4a33, roughness: 0.85, metalness: 0.15 });
  const barrelDark = new THREE.MeshStandardMaterial({ color: 0x3d3226, roughness: 0.85, metalness: 0.15 });
  const barrelGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.2, 16);
  const barrelBand = new THREE.CylinderGeometry(0.51, 0.51, 0.12, 16);
  const barrelSpots = [[-6, 8], [2, -12], [-22, 20], [26, 6], [38, 14], [-30, -20]];
  for (const [x, z] of barrelSpots) {
    const b = new THREE.Mesh(barrelGeo, barrelMat);
    b.position.set(x, 0.6, z);
    b.castShadow = b.receiveShadow = true;
    const band = new THREE.Mesh(barrelBand, barrelDark);
    b.add(band);
    scene.add(b);
    obstacles.push({ x, z, r: 0.7 });
  }

  // A low concrete L-barrier near the middle for quick cover.
  const concrete = new THREE.MeshStandardMaterial({ color: 0x7d8794, roughness: 0.95 });
  const wallA = new THREE.Mesh(new THREE.BoxGeometry(8, 1.5, 0.6), concrete);
  wallA.position.set(12, 0.75, 2);
  const wallB = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.5, 8), concrete);
  wallB.position.set(12, 0.75, 6);
  wallA.castShadow = wallA.receiveShadow = true;
  wallB.castShadow = wallB.receiveShadow = true;
  scene.add(wallA, wallB);
  obstacles.push({ x: 12, z: 2, halfX: 4, halfZ: 0.3, box: true });
  obstacles.push({ x: 12, z: 6, halfX: 0.3, halfZ: 4, box: true });

  // A few more crates, tucked into previously empty open spots.
  const crateMat2 = new THREE.MeshStandardMaterial({ color: 0x6a5e4a, roughness: 0.9 });
  const extraCrateSpots = [[-2, 38], [8, 30], [52, -26], [-52, 10]];
  for (const [x, z] of extraCrateSpots) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), crateMat2);
    c.position.set(x, 1, z);
    c.rotation.y = Math.random() * Math.PI;
    c.castShadow = c.receiveShadow = true;
    scene.add(c);
    obstacles.push({ x, z, r: 1.65 });
  }
}

// A stacked-crate platform you can climb onto (press E): low cover on the way
// up, then a small walkable railed deck on top. Pushes the same climb data the
// watchtowers use, so the existing climb mechanic works unchanged.
function buildCratePlatform(cx, cz, height) {
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x6a5e4a, roughness: 0.9 });
  const darkMat  = new THREE.MeshStandardMaterial({ color: 0x4c4234, roughness: 0.9 });
  const railMat  = new THREE.MeshStandardMaterial({ color: 0x2b333f, roughness: 0.7 });

  const half = 1.5;
  const steps = Math.max(2, Math.round(height / 0.9));
  for (let i = 0; i < steps; i++) {
    const y = (i + 0.5) * (height / steps);
    const c = new THREE.Mesh(
      new THREE.BoxGeometry(half * 2, height / steps - 0.06, half * 2),
      i % 2 ? darkMat : crateMat
    );
    c.position.set(cx, y, cz);
    c.rotation.y = (i % 2 ? 0.35 : 0);
    c.castShadow = c.receiveShadow = true;
    scene.add(c);
  }

  const deckTopY = height + 0.2;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 0.5, 0.3, half * 2 + 0.5), crateMat);
  deck.position.set(cx, height + 0.15, cz);
  deck.castShadow = deck.receiveShadow = true;
  scene.add(deck);

  const railH = 0.9, span = half + 0.25;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, railH, 0.08), railMat);
      post.position.set(cx + sx * span, height + railH / 2 + 0.3, cz + sz * span);
      scene.add(post);
    }
  }
  for (const rr of [0.5, railH]) {
    for (const sz of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(span * 2, 0.07, 0.07), railMat);
      rail.position.set(cx, height + rr + 0.3, cz + sz * span);
      scene.add(rail);
    }
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, span * 2), railMat);
      rail.position.set(cx + sx * span, height + rr + 0.3, cz);
      scene.add(rail);
    }
  }

  // A straight external staircase up the arena-facing side (press E to climb):
  // a sloped stringer, treads and two handrails — same climb centreline the
  // player (and the chasing zombies) slide along.
  const baseR = half + 0.6;
  const toC = new THREE.Vector2(0 - cx, 0 - cz);
  const L = Math.hypot(toC.x, toC.y) || 1;
  const ux = toC.x / L, uz = toC.y / L;
  const walkR = half + 0.25;
  const footR = baseR + PLAYER_RADIUS;
  const topR = half + 0.1;
  {
    const basePt = new THREE.Vector3(cx + ux * footR, 0, cz + uz * footR);
    const topPt = new THREE.Vector3(cx + ux * topR, deckTopY, cz + uz * topR);
    const dir = new THREE.Vector3().subVectors(topPt, basePt);
    const len = dir.length();
    const lm = new THREE.MeshStandardMaterial({ color: 0x3a2f22, roughness: 0.9 });
    const stair = new THREE.Group();
    const stringer = new THREE.Mesh(new THREE.BoxGeometry(0.6, len, 0.14), lm);
    stringer.position.set(0, len / 2, 0);
    stair.add(stringer);
    const treads = Math.max(4, Math.round(deckTopY / 0.4));
    for (let i = 1; i <= treads; i++) {
      const tread = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.09, 0.42), crateMat);
      tread.position.set(0, (len / treads) * i, 0.04);
      stair.add(tread);
    }
    for (const sx of [-0.32, 0.32]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, len * 1.03, 0.06), railMat);
      rail.position.set(sx, len / 2 + 0.5, 0.04);
      stair.add(rail);
      for (const fy of [0.12, 0.5, 0.88]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.05), railMat);
        post.position.set(sx, len * fy, 0.04);
        stair.add(post);
      }
    }
    stair.position.copy(basePt);
    stair.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    scene.add(stair);
  }

  obstacles.push({ x: cx, z: cz, r: baseR });
  towers.push({ x: cx, z: cz, deckTop: deckTopY, walkR, footR, topR, baseR, ux, uz });
}
buildCratePlatform(14, 20, 2.6);
buildCratePlatform(-34, -6, 3.0);
buildCratePlatform(42, -2, 3.4);

// --- Sky texture (equirectangular: 2:1, gradient + a moon) — generated, no asset file ---
// Mapped onto the inside of a large sphere; the moon and stars are therefore
// pinned to fixed world directions on the dome.
function makeSkyTexture() {
  const w = 1024, h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Vertical gradient over the full height (top of dome -> horizon).
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#0d1524');
  g.addColorStop(0.5, '#182540');
  g.addColorStop(0.75, '#223250'); // horizon band
  g.addColorStop(1, '#26395a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // a soft moon, pinned to a fixed spot on the dome
  const mx = w * 0.7, my = h * 0.24, r = 46;
  const moon = ctx.createRadialGradient(mx, my, 2, mx, my, r);
  moon.addColorStop(0, 'rgba(232,240,255,0.95)');
  moon.addColorStop(0.5, 'rgba(185,205,245,0.5)');
  moon.addColorStop(1, 'rgba(120,150,200,0)');
  ctx.fillStyle = moon;
  ctx.fillRect(0, 0, w, h);

  // stars, scattered across the upper part of the dome
  for (let i = 0; i < 500; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h * 0.55;
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.85})`;
    const s = Math.random() * 2.2 + 0.2;
    ctx.fillRect(x, y, s, s);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}
