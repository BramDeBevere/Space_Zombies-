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
// a focal point. The whole footprint blocks movement (one circular collider).
{
  const [tx, tz] = [-20, 40];
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a4630, roughness: 0.85 });
  const darkWoodMat = new THREE.MeshStandardMaterial({ color: 0x40321f, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.7, metalness: 0.15 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x2b333f, roughness: 0.7 });

  const half = 2.6;        // half-width of the tower footprint
  const deckY = 5.4;       // height of the raised deck

  // Four corner support posts, from the ground up to the deck.
  const postGeo = new THREE.CylinderGeometry(0.28, 0.34, deckY, 8);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, woodMat);
      post.position.set(tx + sx * half, deckY / 2, tz + sz * half);
      post.castShadow = true;
      scene.add(post);
    }
  }

  // A horizontal brace on the two long sides, tying the posts together.
  const braceGeo = new THREE.BoxGeometry(0.12, 0.12, half * 2);
  for (const sx of [-1, 1]) {
    const brace = new THREE.Mesh(braceGeo, darkWoodMat);
    brace.position.set(tx + sx * half, deckY * 0.5, tz);
    scene.add(brace);
  }

  // The raised deck you can look out from.
  const deck = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 0.8, 0.4, half * 2 + 0.8), woodMat);
  deck.position.set(tx, deckY, tz);
  deck.castShadow = true;
  deck.receiveShadow = true;
  scene.add(deck);

  // Railings around all four sides of the deck.
  const railH = 1.1;
  const railSpan = half * 2 + 0.8;
  const railFront = new THREE.BoxGeometry(railSpan, railH, 0.12);
  const railSide = new THREE.BoxGeometry(0.12, railH, railSpan);
  for (const sz of [-1, 1]) {
    const rail = new THREE.Mesh(railFront, railMat);
    rail.position.set(tx, deckY + railH / 2 + 0.2, tz + sz * (half + 0.3));
    scene.add(rail);
  }
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(railSide, railMat);
    rail.position.set(tx + sx * (half + 0.3), deckY + railH / 2 + 0.2, tz);
    scene.add(rail);
  }

  // A little pyramid roof.
  const roof = new THREE.Mesh(new THREE.ConeGeometry(half * 2 + 1.2, 2.4, 4), roofMat);
  roof.position.set(tx, deckY + 2.0, tz);
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  scene.add(roof);

  // A warm beacon at the very top, echoing the streetlights.
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0x11131a, emissive: 0xffcf87, emissiveIntensity: 3.4,
  });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 12), bulbMat);
  beacon.position.set(tx, deckY + 3.2, tz);
  scene.add(beacon);

  // The whole tower blocks movement (one circular collider at the base).
  obstacles.push({ x: tx, z: tz, r: half + 1.1 });
}

// --- A building: four brick walls with a door, lit windows and a flat roof ---
// Placed in the opposite corner from the watchtower. The whole footprint is a
// single box collider, so the player and zombies slide around it as cover.
{
  const [bx, bz] = [30, -22];
  const bw = 7, bd = 6;        // half-widths of the footprint
  const H = 6, T = 0.5;        // wall height and thickness
  const brick = new THREE.MeshStandardMaterial({ color: 0x6e5245, roughness: 0.9 });
  const roofM = new THREE.MeshStandardMaterial({ color: 0x46362b, roughness: 0.7 });
  const winM  = new THREE.MeshStandardMaterial({ color: 0x241c12, emissive: 0xffc079, emissiveIntensity: 1.6 });
  const doorM = new THREE.MeshStandardMaterial({ color: 0x2a2016, roughness: 0.9 });

  // Four walls; the centre-facing (north) wall is split around a door gap.
  const doorW = 3;
  const north = bz + bd;
  const segLen = bw - doorW / 2; // each side segment of the north wall
  const northWest = new THREE.Mesh(new THREE.BoxGeometry(segLen, H, T), brick);
  northWest.position.set(bx - (doorW / 2 + segLen / 2), H / 2, north);
  const northEast = new THREE.Mesh(new THREE.BoxGeometry(segLen, H, T), brick);
  northEast.position.set(bx + (doorW / 2 + segLen / 2), H / 2, north);
  const south = new THREE.Mesh(new THREE.BoxGeometry(bw * 2, H, T), brick);
  south.position.set(bx, H / 2, bz - bd);
  const west = new THREE.Mesh(new THREE.BoxGeometry(T, H, bd * 2), brick);
  west.position.set(bx - bw, H / 2, bz);
  const east = new THREE.Mesh(new THREE.BoxGeometry(T, H, bd * 2), brick);
  east.position.set(bx + bw, H / 2, bz);
  [northWest, northEast, south, west, east].forEach((m) => {
    m.castShadow = m.receiveShadow = true; scene.add(m);
  });

  // Door: a lintel over the gap and a recessed panel.
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorW, 1.2, T), brick);
  lintel.position.set(bx, H - 0.6, north);
  scene.add(lintel);
  const door = new THREE.Mesh(new THREE.BoxGeometry(doorW - 0.4, 4.2, T * 0.5), doorM);
  door.position.set(bx, 2.1, north - T * 0.5);
  scene.add(door);

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

  // The whole building blocks movement (one axis-aligned box collider).
  obstacles.push({ x: bx, z: bz, halfX: bw, halfZ: bd, box: true });
}

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
