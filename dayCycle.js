// dayCycle.js — a day/night cycle that re-lights the arena, crossfades the
// day/night sky domes, tints the fog, and (via nightFactor) lets the spawn
// logic bias nocturnal creatures. Driven once per frame from main.animate().
//
// The world boots at midnight (the light/fog defaults in world.js match the
// NIGHT keyframe), so no separate init step is required.
import * as THREE from 'three';
import { scene, sunLight, hemi, dayDome, renderer } from './world.js';

// One full day (midnight -> noon -> midnight) this many seconds.
export const CYCLE_SECONDS = 90;

// Two keyframes the whole cycle eases between:
//   NIGHT (phase 0 / 1) — cold moonlight, blue-black fog, night sky dome shown.
//   DAY   (phase 0.5)   — warm sunlight, light haze, day sky dome shown.
const NIGHT = {
  sunColor: 0xb6d0ff, sunInt: 2.7, sunPos: [-30, 50, 20],
  hemiSky: 0x6b80a8, hemiGround: 0x242e42, hemiInt: 1.8,
  fogColor: 0x2a3852, fogDensity: 0.0072,
  exposure: 1.7,
};
const DAY = {
  sunColor: 0xfff1d6, sunInt: 3.4, sunPos: [45, 70, 25],
  hemiSky: 0xbfd4ff, hemiGround: 0x6b7a5a, hemiInt: 2.4,
  fogColor: 0xa9bcd8, fogDensity: 0.0042,
  exposure: 1.3,
};

let t = 0.0; // 0..1 phase. 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
const _ca = new THREE.Color();
const _cb = new THREE.Color();

function lerp(a, b, k) { return a + (b - a) * k; }

/** Advance the cycle by dt seconds and re-apply the lighting for this phase. */
export function updateDayNight(dt) {
  t = (t + dt / CYCLE_SECONDS) % 1;
  apply();
}

/** 0 = full day, 1 = full night (smooth cosine, no hard step). */
export function nightFactor() {
  return 0.5 - Math.cos(t * Math.PI * 2) * 0.5;
}

/** Convenience for UI/logic: dark enough to count as "night". */
export function isNight() { return nightFactor() > 0.6; }

export function getPhase() { return t; }

function apply() {
  // dayAmount: 0 at the midnight keyframe, 1 at the noon keyframe. The cosine
  // already gives a gradual sunrise/sunset, so we use it directly as the blend.
  const k = 0.5 - Math.cos(t * Math.PI * 2) * 0.5;

  // Sun / moon directional light: colour, intensity and position.
  sunLight.color.lerpColors(_ca.set(NIGHT.sunColor), _cb.set(DAY.sunColor), k);
  sunLight.intensity = lerp(NIGHT.sunInt, DAY.sunInt, k);
  sunLight.position.set(
    lerp(NIGHT.sunPos[0], DAY.sunPos[0], k),
    lerp(NIGHT.sunPos[1], DAY.sunPos[1], k),
    lerp(NIGHT.sunPos[2], DAY.sunPos[2], k),
  );

  // Hemisphere fill: sky + ground tints and overall level.
  hemi.color.lerpColors(_ca.set(NIGHT.hemiSky), _cb.set(DAY.hemiSky), k);
  hemi.groundColor.lerpColors(_ca.set(NIGHT.hemiGround), _cb.set(DAY.hemiGround), k);
  hemi.intensity = lerp(NIGHT.hemiInt, DAY.hemiInt, k);

  // Fog: colour + density so the arena reads as day or night.
  if (scene.fog) {
    scene.fog.color.lerpColors(_ca.set(NIGHT.fogColor), _cb.set(DAY.fogColor), k);
    scene.fog.density = lerp(NIGHT.fogDensity, DAY.fogDensity, k);
  }

  // Crossfade the day sky dome over the night dome (0 = night sky, 1 = day sky).
  if (dayDome) dayDome.material.opacity = k;

  renderer.toneMappingExposure = lerp(NIGHT.exposure, DAY.exposure, k);
}
