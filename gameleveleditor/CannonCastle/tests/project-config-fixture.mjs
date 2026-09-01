import { readFile } from 'node:fs/promises';

import { decodeGlobalConfig } from '../static/js/global-config-document.js';

export const globalDocument = JSON.parse(await readFile(new URL('../全局配置.json', import.meta.url), 'utf8'));
const decoded = decodeGlobalConfig(globalDocument);
export const config = decoded.config;
export const assets = decoded.assets;

export async function readExportedLevel(fileName) {
  return JSON.parse(await readFile(new URL(`../level/${fileName}`, import.meta.url), 'utf8'));
}
