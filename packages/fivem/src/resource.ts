/**
 * Builds the FiveM resource: fxmanifest.lua, config.lua, client.lua, optional server.lua,
 * README.md, stream/<asset>.ypt, and an optional `source/` folder with the editable
 * `.ypt.xml` + DDS (so CodeWalker users can open exactly what VFXForge exported).
 *
 * The builder is pure: bytes in, bytes out. Writing to disk / zipping the user-visible
 * artefact happens in {@link packageResource}.
 */
import { assertSafeRelativePath, isValidIdentifier, sanitizeIdentifier } from '@vfxforge/core';
import { type BindingPlan, type MappingNote } from '@vfxforge/ypt';
import { zipSync } from 'fflate';
import clientLua from '../templates/client.lua?raw';
import serverLua from '../templates/server.lua?raw';
import { lbool, lnum, lstr, lvec } from './lua';
import { isWeaponName, weaponHash } from './weapons';

export interface SyncOptions {
  enabled: boolean;
  radius: number;
  minIntervalMs: number;
}

export interface ResourceOptions {
  resourceName: string;
  assetName: string;
  author: string;
  description?: string;
  version?: string;
  weapons: string[];
  sync: SyncOptions;
  debug: boolean;
  enableTestCommand: boolean;
  testCommand: string;
  assetTimeoutMs: number;
  /** Minimum time between attempts to load the asset after a failure. */
  assetRetryMs: number;
  idlePollMs: number;
  /** Minimum time between one-shot starts of the same effect (anti-flood for automatic weapons). */
  minIntervalMs: number;
}

export const DEFAULT_RESOURCE_OPTIONS: Omit<ResourceOptions, 'resourceName' | 'assetName' | 'weapons' | 'author'> = {
  sync: { enabled: false, radius: 60, minIntervalMs: 60 },
  debug: false,
  enableTestCommand: true,
  testCommand: 'vfxtest',
  assetTimeoutMs: 10_000,
  assetRetryMs: 5000,
  idlePollMs: 300,
  minIntervalMs: 50,
};

export interface ResourceInput {
  options: ResourceOptions;
  bindings: BindingPlan[];
  /** Binary YPT (validated by the converter bridge). Required unless `sourceOnly`. */
  ypt: Uint8Array | null;
  /** The editable CodeWalker XML + DDS files that produced the YPT. */
  source?: { xml: string; dds: Record<string, Uint8Array> };
  notes: MappingNote[];
  /** Free-form lines for the README "Validation" section (e.g. bridge round-trip result). */
  validationSummary: string[];
  /** Produce a package WITHOUT a stream/*.ypt (when no verified converter is available). */
  sourceOnly?: boolean;
}

export interface ResourceFiles {
  files: Record<string, Uint8Array>;
  warnings: string[];
}

const enc = new TextEncoder();

export function validateOptions(o: ResourceOptions): string[] {
  const errors: string[] = [];
  if (!isValidIdentifier(o.resourceName)) errors.push(`Resource name "${o.resourceName}" must be a lowercase identifier (a-z, 0-9, _).`);
  if (!isValidIdentifier(o.assetName)) errors.push(`Asset name "${o.assetName}" must be a lowercase identifier (a-z, 0-9, _).`);
  if (!isValidIdentifier(o.testCommand)) errors.push(`Test command "${o.testCommand}" must be a lowercase identifier.`);
  for (const w of o.weapons) if (!isWeaponName(w)) errors.push(`"${w}" is not a valid weapon name (expected WEAPON_…).`);
  if (!(o.sync.radius > 0 && o.sync.radius <= 1000)) errors.push('Sync radius must be between 0 and 1000 metres.');
  if (!(o.sync.minIntervalMs >= 0)) errors.push('Sync interval must be non-negative.');
  if (!(o.assetTimeoutMs >= 1000 && o.assetTimeoutMs <= 120_000)) errors.push('Asset timeout must be between 1 and 120 seconds.');
  if (!(o.assetRetryMs >= 1000 && o.assetRetryMs <= 300_000)) errors.push('Asset retry interval must be between 1 and 300 seconds.');
  if (!(o.idlePollMs >= 50 && o.idlePollMs <= 5000)) errors.push('Idle poll interval must be between 50 and 5000 ms.');
  return errors;
}

export function buildConfigLua(o: ResourceOptions, bindings: BindingPlan[]): string {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);
  push('-- VFXForge weapon effects — configuration');
  push('-- Edit freely; the particle dictionary (stream/*.ypt) does not need to be rebuilt for any of these.');
  push('');
  push('Config = {}');
  push('');
  push('-- Name of the particle asset: the file in stream/ without ".ypt".');
  push(`Config.Asset = ${lstr(o.assetName)}`);
  push('');
  push('-- Weapons that trigger effects. Leave the list EMPTY to react to every weapon.');
  push('Config.Weapons = {');
  for (const w of o.weapons) push(`    ${lstr(w)},`);
  push('}');
  push('');
  push(`Config.Debug = ${lbool(o.debug)}                -- print what the script is doing`);
  push(`Config.AssetTimeoutMs = ${lnum(o.assetTimeoutMs)}      -- give up loading the particle asset after this long`);
  push(`Config.AssetRetryMs = ${lnum(o.assetRetryMs)}        -- after a failed load, wait this long before trying again`);
  push(`Config.IdlePollMs = ${lnum(o.idlePollMs)}            -- how often to check for a weapon change while not armed with a tracked weapon`);
  push('');
  push(`Config.EnableTestCommand = ${lbool(o.enableTestCommand)}   -- /${o.testCommand} [effect number|stop]`);
  push(`Config.TestCommand = ${lstr(o.testCommand)}`);
  push('');
  push('-- Show your effects to other players (needs the server script; see README).');
  push('Config.Sync = {');
  push(`    enabled = ${lbool(o.sync.enabled)},`);
  push(`    radius = ${lnum(o.sync.radius)},         -- metres within which other players render your effects`);
  push(`    minIntervalMs = ${lnum(o.sync.minIntervalMs)},  -- server-side rate limit per player`);
  push('}');
  push('');
  push('-- Effects. offset/rotation are relative to the weapon (GTA axes: x right, y forward, z up).');
  push('-- triggers: fired, reloaded, switched, equipped, idle, manual');
  push('Config.Effects = {');
  bindings.forEach((b, i) => {
    push(`    { -- #${i + 1}: ${sanitizeComment(b.effectName)}${b.attachmentName ? ` @ ${sanitizeComment(b.attachmentName)}` : ''}`);
    push(`        effect = ${lstr(b.effectRule)},`);
    push(`        triggers = { ${b.triggers.map((t) => lstr(t)).join(', ')} },`);
    push(`        loop = ${lbool(b.loop)},`);
    push(`        offset = ${lvec(b.offset)},`);
    push(`        rotation = ${lvec(b.rotation)},`);
    push(`        scale = ${lnum(b.scale)},`);
    if (b.bone) push(`        bone = ${lstr(b.bone)},`);
    push(`        minIntervalMs = ${lnum(o.minIntervalMs)},`);
    push('    },');
  });
  push('}');
  push('');
  return lines.join('\n');
}

/** Comments are single-line: strip anything that could end the line or start a long comment. */
function sanitizeComment(s: string): string {
  return s.replace(/[\r\n\u0000-\u001f]/g, ' ').replace(/\]\]|--/g, ' ').slice(0, 80);
}

export function buildManifest(o: ResourceOptions): string {
  const q = lstr;
  const out = [
    "fx_version 'cerulean'",
    "game 'gta5'",
    "lua54 'yes'",
    '',
    `name ${q(o.resourceName)}`,
    `author ${q(o.author || 'VFXForge')}`,
    `description ${q(o.description ?? 'Weapon particle effects generated by VFXForge')}`,
    `version ${q(o.version ?? '1.0.0')}`,
    '',
    "client_scripts { 'config.lua', 'client.lua' }",
  ];
  if (o.sync.enabled) out.push("server_scripts { 'config.lua', 'server.lua' }");
  out.push('');
  return out.join('\n');
}

function statusTable(notes: MappingNote[]): string {
  if (notes.length === 0) return '_No mapping information was recorded._\n';
  const rows = notes.map((n) => `| ${esc(n.effect)} / ${esc(n.emitter)} | \`${esc(n.property)}\` | ${n.status} | ${n.confidence} | ${esc(n.detail)} |`);
  return ['| Effect / emitter | Property | Status | Confidence | Detail |', '|---|---|---|---|---|', ...rows, ''].join('\n');
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function buildReadme(input: ResourceInput): string {
  const o = input.options;
  const weapons = o.weapons.length ? o.weapons : [];
  const hashRows = weapons.map((w) => {
    const h = weaponHash(w);
    return `| \`${h.name}\` | ${h.hash} | ${h.signed} | \`${h.hex}\` |`;
  });
  const unverified = input.notes.filter((n) => n.confidence !== 'verified' || n.status === 'unsupported' || n.status === 'approximated');
  return `# ${o.resourceName}

Weapon particle effects generated with **VFXForge**.

> **Read this first.** VFXForge validates the files it writes and round-trips the YPT through a
> real CodeWalker-based converter, but it cannot launch GTA V. Whether the effect *renders and
> animates correctly in the game* has to be confirmed on a test server — follow the checklist
> at the end of this file before releasing this to players.

## Install

1. Copy the \`${o.resourceName}\` folder into your server's \`resources\` directory.
2. Add \`ensure ${o.resourceName}\` to \`server.cfg\`.
3. ${input.sourceOnly ? '**This is a source-only package** (no `stream/*.ypt`). Convert `source/' + o.assetName + '.ypt.xml` to a binary `.ypt` with CodeWalker and put it in `stream/` as `' + o.assetName + '.ypt`.' : 'Restart the server (or `refresh` + `ensure ' + o.resourceName + '`).'}
4. In game, equip ${weapons.length ? weapons.map((w) => '`' + w + '`').join(' or ') : 'any weapon'} and fire it, or run \`/${o.testCommand}\`.

## What is inside

| Path | Purpose |
|---|---|
| \`fxmanifest.lua\` | Resource manifest (Lua 5.4) |
| \`config.lua\` | **All tuning**: weapons, offsets, rotations, scale, triggers, sync |
| \`client.lua\` | Runtime: loads the asset, detects weapon events, starts/stops effects |
${o.sync.enabled ? '| `server.lua` | Validates and relays effects to nearby players |\n' : ''}| \`stream/${o.assetName}.ypt\` | The particle dictionary${input.sourceOnly ? ' (**missing — see Install**)' : ''} |
${input.source ? `| \`source/\` | Editable \`.ypt.xml\` + \`.dds\` (open in CodeWalker) |\n` : ''}
## Effects

| # | Effect | Triggers | Loop | Offset (x, y, z) | Rotation | Attached to |
|---|---|---|---|---|---|---|
${input.bindings
  .map(
    (b, i) =>
      `| ${i + 1} | \`${esc(b.effectRule)}\` | ${b.triggers.join(', ')} | ${b.loop ? 'yes' : 'no'} | ${b.offset.map((n) => lnum(n)).join(', ')} | ${b.rotation.map((n) => lnum(n)).join(', ')} | ${b.bone ? 'bone `' + esc(b.bone) + '`' : 'weapon entity'} |`,
  )
  .join('\n')}

Offsets and rotations can be changed in \`config.lua\` without rebuilding the particle file.

## Test command

\`/${o.testCommand}\` plays every configured effect on your current weapon (or on your ped if you are unarmed).
\`/${o.testCommand} 2\` plays only effect #2. \`/${o.testCommand} stop\` ends looped effects.
Disable the command for production with \`Config.EnableTestCommand = false\`.

## Triggering from other scripts

\`\`\`lua
exports['${o.resourceName}']:PlayEffect(1)   -- effect number from the table above
exports['${o.resourceName}']:StopEffects()
\`\`\`

## Weapons

An empty \`Config.Weapons\` list reacts to every weapon. Weapon names must exist on your server
(add-on weapons included) — VFXForge only checks their format.

${hashRows.length ? '| Name | Hash (unsigned) | Hash (signed, as `GetHashKey` returns) | Hex |\n|---|---|---|---|\n' + hashRows.join('\n') + '\n' : '_All weapons._\n'}

## Multiplayer

${
  o.sync.enabled
    ? `Sync is **enabled**. The client reports each effect it plays; \`server.lua\` validates the effect number, rate-limits each player (${o.sync.minIntervalMs} ms) and relays only that number to players within about ${lnum(o.sync.radius)} m (server-side filtering needs OneSync; without it every client receives the event and applies the distance check itself).`
    : 'Sync is **disabled**: other players will not see your effects. Enable it with `Config.Sync.enabled = true` **and** add `server.lua` to the manifest (`server_scripts { \'config.lua\', \'server.lua\' }`).'
}

Weapon entities are not networked objects, so the native \`StartNetworkedParticleFx…\` family cannot be used for them; this resource relays its own events instead.

## Validation performed by VFXForge

${input.validationSummary.length ? input.validationSummary.map((l) => '- ' + l).join('\n') : '- (none recorded)'}

## Fidelity report

How each VFXForge property was represented. **approximated**, **unsupported** and **unverified** rows may look different in game from the WebGL preview (which is not GTA V's renderer).

${statusTable(unverified)}

## In-game test checklist

- [ ] \`ensure ${o.resourceName}\` prints no errors; with \`Config.Debug = true\` you see "particle asset … loaded".
- [ ] \`/${o.testCommand}\` shows the effect. If nothing appears, check the F8 console for "could not load particle asset".
- [ ] Firing ${weapons[0] ? '`' + weapons[0] + '`' : 'a weapon'} plays the effect at the expected place on the weapon.
- [ ] The flipbook **animates** (not a static frame, not the whole sheet, not wrong cells). If it does not, the cause is probably the texture's frame/clip-region data — see the Fidelity report and VFXForge's Flipbook report.
- [ ] Switching weapons / dying / respawning leaves no stuck looped effect.
- [ ] Firing quickly with an automatic weapon does not spam the console or tank the frame rate.
- [ ] \`restart ${o.resourceName}\` leaves no orphaned effects.
${o.sync.enabled ? `- [ ] A second player within ${lnum(o.sync.radius)} m sees your effect; one farther away does not.\n` : ''}
## Credits & licences

Generated by VFXForge. The \`.ypt\` was produced from VFXForge's own writer; any CodeWalker-based conversion ran as a separate local tool and no CodeWalker code is included in this resource.
`;
}

/** Assembles every file of the resource (relative paths are the final paths inside the folder). */
export function buildResourceFiles(input: ResourceInput): ResourceFiles {
  const errors = validateOptions(input.options);
  if (errors.length) throw new Error('Cannot build the resource: ' + errors.join(' '));
  if (input.bindings.length === 0) throw new Error('Cannot build the resource: there are no effects to start.');
  const warnings: string[] = [];
  const o = input.options;
  const files: Record<string, Uint8Array> = {};
  const add = (path: string, content: string | Uint8Array) => {
    assertSafeRelativePath(path);
    files[path] = typeof content === 'string' ? enc.encode(content) : content;
  };

  add('fxmanifest.lua', buildManifest(o));
  add('config.lua', buildConfigLua(o, input.bindings));
  add('client.lua', clientLua);
  if (o.sync.enabled) add('server.lua', serverLua);
  if (input.ypt) {
    add(`stream/${o.assetName}.ypt`, input.ypt);
  } else if (!input.sourceOnly) {
    throw new Error('Cannot build a loadable resource without a binary YPT. Use a verified converter, or choose a source-only package.');
  } else {
    warnings.push('Source-only package: there is no stream/*.ypt, so the resource will not load an effect until you convert and add it.');
  }
  if (input.source) {
    add(`source/${o.assetName}.ypt.xml`, input.source.xml);
    for (const [name, bytes] of Object.entries(input.source.dds)) add(`source/${name}`, bytes);
  }
  add('README.md', buildReadme(input));
  return { files, warnings };
}

export interface PackagedResource {
  /** Files with the final `resourceName/…` prefix. */
  files: Record<string, Uint8Array>;
  zip: Uint8Array;
  warnings: string[];
  totalBytes: number;
}

/** Zips the resource under a single top-level folder. Output is byte-for-byte reproducible. */
export function packageResource(input: ResourceInput): PackagedResource {
  const built = buildResourceFiles(input);
  const root = sanitizeIdentifier(input.options.resourceName);
  const entries: Record<string, [Uint8Array, { mtime: Date; level: 6 | 0 }]> = {};
  const fixed = new Date(Date.UTC(2020, 0, 1)); // reproducible archives
  const files: Record<string, Uint8Array> = {};
  for (const path of Object.keys(built.files).sort()) {
    const full = `${root}/${path}`;
    files[full] = built.files[path]!;
    // already-compressed payloads are stored; text is deflated
    const stored = path.endsWith('.ypt') || path.endsWith('.dds');
    entries[full] = [built.files[path]!, { mtime: fixed, level: stored ? 0 : 6 }];
  }
  const zip = zipSync(entries);
  let total = 0;
  for (const b of Object.values(files)) total += b.length;
  return { files, zip, warnings: built.warnings, totalBytes: total };
}
