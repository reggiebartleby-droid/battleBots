/**
 * BattleBots core data model.
 * Engine-agnostic: no rendering, no physics. Used by the bot builder,
 * the turn-based combat module, and later the real-time server.
 */

// ---------- Bodies ----------

export type BodyId =
  | 'vertical_spinner'
  | 'horizontal_spinner'
  | 'overhead'
  | 'flipper'
  | 'control'
  | 'full_body_spinner';

/** Socket types. Each body declares which sockets it has. */
/** weapon_motor: the weapon's own drive (spinner motor v0.8/v0.9, overhead arm motor v0.10, flipper ram + valves / lifter / hydraulic pump / shell motor v0.12). At 0 HP the weapon can't be powered. */
export type SocketType = 'weapon' | 'weapon_motor' | 'front' | 'armor' | 'wheels' | 'motor' | 'secondary';

export interface SocketDef {
  /** Unique within the body, e.g. "armor_1", "armor_2", "wheels_left". */
  id: string;
  type: SocketType;
  /** false = may be left empty ("none"). Default true. */
  required?: boolean;
}

export interface BodyDef {
  id: BodyId;
  name: string;
  description: string;
  /** Max total part weight. */
  weightLimit: number;
  sockets: SocketDef[];
  /** Weapon kinds this body accepts in its weapon socket (hard compatibility rule). */
  allowedWeaponKinds: WeaponKind[];
}

// ---------- Parts ----------

export type PartType = SocketType;

export type WeaponKind =
  // vertical spinner
  | 'disc' | 'bar' | 'drum'
  // horizontal spinner
  | 'h_bar' | 'h_disc' | 'undercutter'
  // overhead
  | 'hammer' | 'saw' | 'hammer_saw'
  // flipper
  | 'pneumatic_flipper' | 'electric_flipper'
  // control
  | 'lifter' | 'grappler' | 'crusher'
  // full-body spinner
  | 'shell' | 'cage';

export type FrontKind = 'wedge' | 'wedgelet' | 'plow';
export type SecondaryKind = 'flame';

export type PartKind = WeaponKind | FrontKind | SecondaryKind;

/** Raw stats. Weight is NOT stored - it is derived (see weight.ts). */
export interface PartStats {
  hp: number;
  armor?: number;
  damage?: number;
  /** Drive motors only. */
  speed?: number;
}

/**
 * Special traits. The one place the build system is not fully engine-agnostic:
 * each combat engine decides how (or whether) to honor a trait.
 */
export type Trait =
  | 'hinged'            // wedgelet: resists vertical spinners
  | 'fixed'             // wedge: beats horizontals
  | 'weapon_is_armor'   // full-body shell/cage: weapon doubles as armor
  | 'instant'           // pneumatic flipper
  | 'torque'            // electric flipper
  | 'grip'              // grappler/crusher: can hold the opponent
  | 'burn';             // flame: damage over time

/** v0.21 wheel layout (wheels parts only): driven wheels per side. 2wd = one centre axle + skids. */
export type WheelLayout = '2wd' | '4wd' | '6wd';

export interface PartDef {
  id: string;
  name: string;
  type: PartType;
  /** Required for weapon/front/secondary; absent for armor/wheels/motor. */
  kind?: PartKind;
  stats: PartStats;
  /** Wheels parts only (v0.21). */
  layout?: WheelLayout;
  traits?: Trait[];
  description?: string;
}

// ---------- Balance ----------

export interface BalanceConfig {
  /** Fixed weight per part type. */
  baseWeight: Record<PartType, number>;
  /** weight += stat * coefficient. */
  coefficients: Record<keyof PartStats, number>;
}

// ---------- Builds ----------

export interface Cosmetics {
  name: string;
  teamName?: string;
  paint?: string;      // hex color
  decals?: string[];
}

/** A player's assembled bot. Only references ids; resolved against the catalog. */
export interface BotBuild {
  bodyId: BodyId;
  /** socketId -> partId (or null for an empty optional socket). */
  sockets: Record<string, string | null>;
  cosmetics: Cosmetics;
}

// ---------- Catalog ----------

export interface Catalog {
  bodies: Record<BodyId, BodyDef>;
  parts: Record<string, PartDef>;
  balance: BalanceConfig;
}
