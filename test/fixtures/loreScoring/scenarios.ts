/**
 * Synthetic evaluation scenarios for the deterministic lore scorer (debug-only PoC). Deterministic,
 * LLM-free fixtures used by both the regression test (`test/loreScoringScenarios.test.ts`) and the
 * parameter tuner (`test/loreScoringTuner.test.ts`).
 *
 * CLEAN-ROOM: every book name, entry key, comment, and content string below is original, authored for
 * this harness. Nothing is copied from any imported card, ST preset, or third-party lorebook. Generic
 * xianxia/fantasy flavor only.
 *
 * Per scenario, `relevant` entries SHOULD fire and `hardNegative` entries should NOT; entries in neither
 * set are "don't care". Refs join on (bookName, entryIndex) — the entry's position in its book array.
 */

import type { Lorebook, LorebookEntry } from '../../../src/main/types/character'
import type { ScoreSegment } from '../../../src/main/services/loreScoring'

export interface EntryRef {
  bookName: string
  entryIndex: number
}

export interface Scenario {
  name: string
  category: string
  books: Array<{ name: string; lorebook: Lorebook }>
  segments: ScoreSegment[]
  pinText: string
  relevant: EntryRef[]
  hardNegative: EntryRef[]
  /** Entries that fired on the PREVIOUS floor (chat-continuity), keyed like every other ref. Fed to the
   *  scorer's `prevFired` set so the persistence multiplier can apply. Absent = empty (the common case).
   *  The keyword baseline ignores it. */
  prevFired?: EntryRef[]
}

/** Build a full LorebookEntry from a partial (schema-default fields filled in). */
const E = (o: Partial<LorebookEntry>): LorebookEntry => ({
  keys: [],
  secondary_keys: [],
  content: '',
  enabled: true,
  insertion_order: 100,
  insertion_depth: null,
  case_sensitive: false,
  constant: false,
  selective: false,
  probability: 100,
  exclude_recursion: false,
  prevent_recursion: false,
  comment: '',
  ...o
})

const book = (name: string, entries: LorebookEntry[]): { name: string; lorebook: Lorebook } => ({
  name,
  lorebook: { name, entries }
})

const seg = (depth: number, text: string): ScoreSegment => ({ depth, text })
const ref = (bookName: string, entryIndex: number): EntryRef => ({ bookName, entryIndex })

// --- Category 9 helper: procedurally pad a book with deterministic distractors (NO Math.random). ---
const bigBookEntries = (): LorebookEntry[] => {
  const entries: LorebookEntry[] = []
  for (let i = 0; i < 150; i++) {
    // Each distractor is keyed on a unique relic id (never in the transcript) plus the generic word
    // 'artifact' (which IS in the transcript) — a low-idf common-word trap.
    entries.push(
      E({
        keys: [`Relic_${i}`, 'artifact'],
        content: `Catalogued artifact number ${i}, of no particular renown.`,
        comment: `Distractor ${i}`,
        insertion_order: 500 + i
      })
    )
  }
  // idx 150..152 — genuinely-matched relevant entries with specific, rare keys.
  entries.push(E({ keys: ['Skyforge Anvil'], content: 'A smithing altar of fallen stars.', comment: 'Skyforge' }))
  entries.push(E({ keys: ['Tideglass Mirror'], content: 'A scrying pane of frozen sea.', comment: 'Tideglass' }))
  entries.push(E({ keys: ['Emberheart Gem'], content: 'A stone that holds a living flame.', comment: 'Emberheart' }))
  return entries
}

/** The original tuned suite (byte-identical). Regression FLOORS are computed over THIS list so the
 *  broad-evidence / persistence scenarios (which deliberately under-fire at current defaults) can't drag
 *  the floors below their thresholds before the owner decides on retuned defaults. */
export const ORIGINAL_SCENARIOS: Scenario[] = [
  // === 1. Stale mention (×3) ===
  {
    name: 'stale-mention-far',
    category: 'stale',
    books: [
      book('Emberwilds', [
        E({ keys: ['Cinderpeak Shrine'], content: 'A ruined shrine on the volcano rim.', comment: 'Cinderpeak' }),
        E({ keys: ['Duskmarket'], content: 'A bustling night bazaar of lanterns.', comment: 'Duskmarket' })
      ])
    ],
    segments: [
      seg(0, 'We plan our next move for the evening.'),
      seg(1, 'We wander into the Duskmarket looking for a rare talisman.'),
      seg(7, 'Long ago we climbed to the Cinderpeak Shrine and left an offering.')
    ],
    pinText: '',
    relevant: [ref('Emberwilds', 1)],
    hardNegative: [ref('Emberwilds', 0)]
  },
  {
    name: 'stale-mention-fresh-twin',
    category: 'stale',
    books: [
      book('Emberwilds', [
        E({ keys: ['Cinderpeak Shrine'], content: 'A ruined shrine on the volcano rim.', comment: 'Cinderpeak' }),
        E({ keys: ['Duskmarket'], content: 'A bustling night bazaar of lanterns.', comment: 'Duskmarket' })
      ])
    ],
    segments: [
      seg(0, 'We set out for the Cinderpeak Shrine at first light.'),
      seg(1, 'We wander into the Duskmarket for supplies.'),
      seg(7, 'Long ago we first glimpsed the Cinderpeak Shrine from afar.')
    ],
    pinText: '',
    relevant: [ref('Emberwilds', 0), ref('Emberwilds', 1)],
    hardNegative: []
  },
  {
    name: 'stale-mention-far-with-fresh',
    category: 'stale',
    books: [
      book('Frostreach', [
        E({ keys: ['Glacier Gate'], content: 'The northern pass sealed in ancient ice.', comment: 'GlacierGate' }),
        E({ keys: ['Snowpetal Sect'], content: 'A reclusive order of ice cultivators.', comment: 'Snowpetal' }),
        E({ keys: ['Hollow Tarn'], content: 'A frozen lake said to swallow travelers.', comment: 'HollowTarn' })
      ])
    ],
    segments: [
      seg(0, 'We approach the Snowpetal Sect gates seeking shelter.'),
      seg(1, 'The disciples eye us warily.'),
      seg(8, 'Weeks ago we crossed the Glacier Gate and nearly froze.')
    ],
    pinText: '',
    relevant: [ref('Frostreach', 1)],
    hardNegative: [ref('Frostreach', 0)]
  },

  // === 2. Common-word collision ===
  {
    name: 'common-word-collision',
    category: 'collision',
    books: [
      book('SwordSchools', [
        E({ keys: ['sword', 'Moonshadow Blade'], content: 'The Moonshadow Blade, a legendary sword of the old war.', comment: 'Moonshadow' }),
        E({ keys: ['sword'], content: 'The Redpine school drills with the sword daily.', comment: 'Redpine' }),
        E({ keys: ['sword'], content: 'The Cloudfoot school favors the light sword.', comment: 'Cloudfoot' }),
        E({ keys: ['sword'], content: 'The Ironvale school forges its own sword steel.', comment: 'Ironvale' }),
        E({ keys: ['sword'], content: 'The Riverbend school teaches the curved sword.', comment: 'Riverbend' }),
        E({ keys: ['sword'], content: 'The Thornhall school pairs shield and sword.', comment: 'Thornhall' }),
        E({ keys: ['sword'], content: 'The Duskwind school hides a sword in the sleeve.', comment: 'Duskwind' }),
        E({ keys: ['sword'], content: 'The Stonecrest school wields a heavy sword.', comment: 'Stonecrest' })
      ])
    ],
    segments: [seg(0, 'I draw my sword and ask the elder about the Moonshadow Blade.')],
    pinText: '',
    relevant: [ref('SwordSchools', 0)],
    hardNegative: [
      ref('SwordSchools', 1),
      ref('SwordSchools', 2),
      ref('SwordSchools', 3),
      ref('SwordSchools', 4),
      ref('SwordSchools', 5),
      ref('SwordSchools', 6),
      ref('SwordSchools', 7)
    ]
  },

  // === 3. Scene cluster (one-hop links) ===
  {
    name: 'scene-cluster-links',
    category: 'links',
    books: [
      book('JadeVale', [
        E({ keys: ['Jade Vale'], content: 'The Jade Vale, home to the Verdant Pavilion and the recluse Master Bo.', comment: 'JadeVale' }),
        E({ keys: ['Verdant Pavilion'], content: 'A teahouse roofed in green tiles.', comment: 'Verdant' }),
        E({ keys: ['Master Bo'], content: 'An aging swordmaster of few words.', comment: 'MasterBo' }),
        E({ keys: ['Ashen Wastes'], content: 'A distant, lifeless desert.', comment: 'Ashen' })
      ])
    ],
    segments: [seg(0, 'We finally arrive at the Jade Vale after days of travel.')],
    pinText: '',
    relevant: [ref('JadeVale', 0), ref('JadeVale', 1), ref('JadeVale', 2)],
    hardNegative: [ref('JadeVale', 3)]
  },

  // === 4. Pin state beats stale transcript ===
  {
    name: 'pin-state-beats-stale',
    category: 'pin',
    books: [
      book('PortCities', [
        E({ keys: ['Saltspire'], content: 'A harbor city of white towers.', comment: 'Saltspire' }),
        E({ keys: ['Saltspire Docks'], content: 'Wharves crowded with junks.', comment: 'SaltDocks' }),
        E({ keys: ['Grimwater'], content: 'A half-sunken pirate town.', comment: 'Grimwater' })
      ])
    ],
    segments: [
      seg(0, 'We negotiate passage with a nervous smuggler.'),
      seg(5, 'Days ago we fled Grimwater under a hail of arrows.')
    ],
    pinText: '\n[PINS]\nlocation=Saltspire',
    relevant: [ref('PortCities', 0)],
    hardNegative: [ref('PortCities', 2)]
  },

  // === 5. Keyword-correct guard (×3) — obvious fresh matches, no hard negatives ===
  {
    name: 'keyword-guard-oaths',
    category: 'guard',
    books: [
      book('OathHall', [
        E({ keys: ['Ironclad Oath'], content: 'A binding vow sworn on steel.', comment: 'IroncladOath' }),
        E({ keys: ['Silent Bell'], content: 'A bell that tolls without sound.', comment: 'SilentBell' })
      ])
    ],
    segments: [
      seg(0, 'I swear the Ironclad Oath before the altar.'),
      seg(1, 'Behind us the Silent Bell begins to toll.')
    ],
    pinText: '',
    relevant: [ref('OathHall', 0), ref('OathHall', 1)],
    hardNegative: []
  },
  {
    name: 'keyword-guard-beasts',
    category: 'guard',
    books: [
      book('BeastFen', [
        E({ keys: ['Mirefang Serpent'], content: 'A venomous swamp serpent.', comment: 'Mirefang' }),
        E({ keys: ['Gloommoth'], content: 'A moth the size of a cart.', comment: 'Gloommoth' }),
        E({ keys: ['Sunward Crane'], content: 'A crane that never lands.', comment: 'Crane' })
      ])
    ],
    segments: [seg(0, 'A Mirefang Serpent rears from the water as a Gloommoth flutters past.')],
    pinText: '',
    relevant: [ref('BeastFen', 0), ref('BeastFen', 1)],
    hardNegative: []
  },
  {
    name: 'keyword-guard-relics',
    category: 'guard',
    books: [
      book('RelicVault', [
        E({ keys: ['Ninefold Seal'], content: 'A talisman of nine folded charms.', comment: 'Ninefold' }),
        E({ keys: ['Ashen Crown'], content: 'A crown of cooled cinder.', comment: 'AshenCrown' })
      ])
    ],
    segments: [seg(1, 'We pry the Ninefold Seal from the pedestal.')],
    pinText: '',
    relevant: [ref('RelicVault', 0)],
    hardNegative: []
  },

  // === 6. Secondary gate ===
  {
    name: 'secondary-gate',
    category: 'secondary',
    books: [
      book('SelectiveRealm', [
        E({ keys: ['dragon'], secondary_keys: ['volcano'], selective: true, content: 'The scaled dragons of the southern volcano.', comment: 'VolcanoDragon' }),
        E({ keys: ['dragon'], secondary_keys: ['tundra'], selective: true, content: 'The pale dragons of the northern tundra.', comment: 'TundraDragon' })
      ])
    ],
    segments: [seg(0, 'A dragon circles the volcano above our camp.')],
    pinText: '',
    relevant: [ref('SelectiveRealm', 0)],
    hardNegative: [ref('SelectiveRealm', 1)]
  },

  // === 7. Probability ordering (twin evidence, differing probability) ===
  {
    name: 'probability-ordering',
    category: 'probability',
    books: [
      book('ProbRealm', [
        E({ keys: ['Azure Roost'], content: 'A cliffside eyrie of blue feathers.', probability: 100, comment: 'AzureP100' }),
        E({ keys: ['Crimson Roost'], content: 'A cliffside eyrie of red feathers.', probability: 40, comment: 'CrimsonP40' })
      ])
    ],
    segments: [seg(0, 'We rest between the Azure Roost and the Crimson Roost.')],
    pinText: '',
    relevant: [ref('ProbRealm', 0)],
    hardNegative: []
  },

  // === 8. Thin-evidence opening (measures overfiring on low-idf noise) ===
  // A short greeting mentions only a GENERIC word ('traveler') that every entry in the book declares, so
  // its idf is low and every match scores weakly — a sane minScore floor should zero the whole book.
  {
    name: 'thin-evidence-opening',
    category: 'thin',
    books: [
      book(
        'ThinRealm',
        // Content deliberately omits the shared key 'traveler' so the entries don't self-link (spreading
        // activation would otherwise inflate the noise back above a floor).
        Array.from({ length: 10 }, (_, i) =>
          E({
            keys: ['traveler', `Wayside_${i}`],
            content: `A roadside rest stop, waypost ${i}, along the common route.`,
            comment: `Wayside ${i}`
          })
        )
      )
    ],
    segments: [seg(1, 'A quiet evening; a lone traveler warms by the fire.')],
    pinText: '',
    relevant: [],
    hardNegative: Array.from({ length: 10 }, (_, i) => ref('ThinRealm', i))
  },

  // === 9. Big-book noise (procedural distractors) ===
  {
    name: 'big-book-noise',
    category: 'bigbook',
    books: [book('GreatCodex', bigBookEntries())],
    segments: [
      seg(0, 'We recover the Skyforge Anvil, a rare artifact, and the Tideglass Mirror.'),
      seg(1, 'The Emberheart Gem pulses with a slow, living light.')
    ],
    pinText: '',
    relevant: [ref('GreatCodex', 150), ref('GreatCodex', 151), ref('GreatCodex', 152)],
    hardNegative: []
  },

  // === 10. Recursion flags suppress links ===
  {
    name: 'recursion-prevent-source',
    category: 'recursion',
    books: [
      book('SealedVale', [
        E({ keys: ['Sealed Vale'], content: 'The Sealed Vale, hiding the Onyx Gate and the hermit Shen.', prevent_recursion: true, comment: 'SealedVale' }),
        E({ keys: ['Onyx Gate'], content: 'A black gate without a keyhole.', comment: 'OnyxGate' }),
        E({ keys: ['hermit Shen'], content: 'A recluse who speaks to no one.', comment: 'Shen' })
      ])
    ],
    segments: [seg(0, 'We reach the Sealed Vale at last.')],
    pinText: '',
    relevant: [ref('SealedVale', 0)],
    hardNegative: [ref('SealedVale', 1), ref('SealedVale', 2)]
  },
  {
    name: 'recursion-exclude-target',
    category: 'recursion',
    books: [
      book('WardedVale', [
        E({ keys: ['Warded Vale'], content: 'The Warded Vale conceals the Iron Shrine and the seer Rue.', comment: 'WardedVale' }),
        E({ keys: ['Iron Shrine'], content: 'A shrine bound in cold chains.', exclude_recursion: true, comment: 'IronShrine' }),
        E({ keys: ['seer Rue'], content: 'A blind seer of the vale.', comment: 'Rue' })
      ])
    ],
    segments: [seg(0, 'We step through the mist into the Warded Vale.')],
    pinText: '',
    relevant: [ref('WardedVale', 0), ref('WardedVale', 2)],
    hardNegative: [ref('WardedVale', 1)]
  },

  // === 11. Multi-key accumulation ===
  {
    name: 'multi-key-accumulation',
    category: 'multikey',
    books: [
      book('MultiKey', [
        E({ keys: ['Thunder Talon', 'Storm Sigil'], content: 'A gauntlet etched with two storm runes.', comment: 'TwoKey' }),
        E({ keys: ['Gale Mark'], content: 'A bracer bearing a single wind rune.', comment: 'OneKey' })
      ])
    ],
    segments: [seg(0, 'I channel the Thunder Talon and the Storm Sigil, then trace the Gale Mark.')],
    pinText: '',
    relevant: [ref('MultiKey', 0), ref('MultiKey', 1)],
    hardNegative: []
  },

  // === Multi-book join (relevant spread across two books) ===
  {
    name: 'multi-book-fresh',
    category: 'multibook',
    books: [
      book('NorthRealm', [
        E({ keys: ['Auroral Spire'], content: 'A tower crowned in northern lights.', comment: 'Auroral' }),
        E({ keys: ['Frost Wyrm'], content: 'A serpent of living ice.', comment: 'FrostWyrm' })
      ]),
      book('SouthRealm', [
        E({ keys: ['Sunspear Oasis'], content: 'A palm-ringed spring in the dunes.', comment: 'Sunspear' }),
        E({ keys: ['Sand Wraith'], content: 'A ghost that walks the dunes.', comment: 'SandWraith' })
      ])
    ],
    segments: [seg(0, 'From the Auroral Spire we scry the distant Sunspear Oasis.')],
    pinText: '',
    relevant: [ref('NorthRealm', 0), ref('SouthRealm', 0)],
    hardNegative: []
  },

  // === Larger scene cluster (vary book size) ===
  {
    name: 'scene-cluster-large',
    category: 'links',
    books: [
      book('Everdusk', [
        E({ keys: ['Everdusk Court'], content: 'Everdusk Court, seat of Lady Wren, guarded by the Thorn Sentinels and lit by the Gloamfire.', comment: 'EverduskCourt' }),
        E({ keys: ['Lady Wren'], content: 'The court’s soft-spoken regent.', comment: 'LadyWren' }),
        E({ keys: ['Thorn Sentinels'], content: 'Silent guards in bramble armor.', comment: 'Thorns' }),
        E({ keys: ['Gloamfire'], content: 'A cold blue flame that never gutters.', comment: 'Gloamfire' }),
        E({ keys: ['Verdigris Fen'], content: 'A far, forgotten marsh.', comment: 'Verdigris' }),
        E({ keys: ['Cobalt Reach'], content: 'A far, storm-wracked sea.', comment: 'Cobalt' })
      ])
    ],
    segments: [seg(0, 'We are summoned before Everdusk Court.')],
    pinText: '',
    relevant: [ref('Everdusk', 0), ref('Everdusk', 1), ref('Everdusk', 2), ref('Everdusk', 3)],
    hardNegative: [ref('Everdusk', 4), ref('Everdusk', 5)]
  },

  // === 12. Deep but pinned ===
  {
    name: 'deep-but-pinned',
    category: 'deeppin',
    books: [
      book('DeepPin', [
        E({ keys: ['Abyssal Trench'], content: 'A rift in the ocean floor.', comment: 'Abyss' }),
        E({ keys: ['Coral Spire'], content: 'A reef tower of pale coral.', comment: 'Coral' })
      ])
    ],
    segments: [seg(8, 'Long ago we charted the Abyssal Trench from a creaking ship.')],
    pinText: '\n[PINS]\nlocation=Abyssal Trench',
    relevant: [ref('DeepPin', 0)],
    hardNegative: []
  }
]

/**
 * NEW scenarios (2026-07-24) added for the persistence-bonus axis + maxK cap justification.
 *
 * CLEAN-ROOM: every name, key, comment, and prose string below is original, authored for this harness —
 * generic fantasy/sci-fi flavor, nothing copied from any card, preset, or third-party lorebook.
 *
 *  - broad-evidence-*  : 12–14 enabled entries, 9–10 genuinely-evidenced relevant + 3–4 hard negatives.
 *    Every relevant entry has real primary-key evidence at a shallow depth (score well above the floor).
 *    At maxK=4 the cap loses recall (only 4 of 9–10 fire); at maxK 8–12 recall recovers WITHOUT the hard
 *    negatives (which have zero evidence) ever firing.
 *  - persistence-*     : chat-continuity. A few relevant entries have weak-but-nonzero current evidence
 *    (deep segment match) AND fired last floor (`prevFired`). Equal-or-stronger hard negatives are NOT in
 *    prevFired. With persistBoost>1 the persisted relevant survive the floor (A) / win the cap (B) and the
 *    negatives don't; with persistBoost=1 the relevant drop. Each also lists one ZERO-current-evidence
 *    entry in prevFired that must NEVER fire — persistence multiplies, it never resurrects (0 × boost = 0).
 */
export const NEW_SCENARIOS: Scenario[] = [
  // === Broad-evidence A: a warband roster (12 enabled, 9 relevant @ depth 0/1, 3 zero-evidence HN). ===
  {
    name: 'broad-evidence-warband',
    category: 'broad',
    books: [
      book('Warband', [
        E({ keys: ['Captain Yarrow'], content: 'The grizzled leader of the free company.', comment: 'Yarrow' }),
        E({ keys: ['Quartermaster Del'], content: 'Keeper of the packs and the ledger.', comment: 'Del' }),
        E({ keys: ['Standard-bearer Onra'], content: 'She carries the company banner into every field.', comment: 'Onra' }),
        E({ keys: ['Scout Pell'], content: 'A quiet outrider who reads the wind.', comment: 'Pell' }),
        E({ keys: ['Healer Mireen'], content: 'A field surgeon with steady hands.', comment: 'Mireen' }),
        E({ keys: ['Ranger Tolk'], content: 'A longbowman raised in the pinewoods.', comment: 'Tolk' }),
        E({ keys: ['Beastmaster Kurr'], content: 'He keeps the war-hounds calm and fed.', comment: 'Kurr' }),
        E({ keys: ['Smith Braga'], content: 'The company farrier and armorer.', comment: 'Braga' }),
        E({ keys: ['Cook Nessa'], content: 'She rations the stew and hoards the salt.', comment: 'Nessa' }),
        // Hard negatives — never named in the transcript, no evidence.
        E({ keys: ['Phantom Envoy Sable'], content: 'A rumored courier no one has met.', comment: 'Sable-HN' }),
        E({ keys: ['The Undertow Pact'], content: 'A treaty spoken of only in old songs.', comment: 'Undertow-HN' }),
        E({ keys: ['Warden of the Ninth Vault'], content: 'A jailer of a vault long since emptied.', comment: 'Warden-HN' })
      ])
    ],
    segments: [
      seg(0, 'Captain Yarrow calls the muster; Quartermaster Del counts the packs and Standard-bearer Onra raises the banner.'),
      seg(1, 'Scout Pell returns with news, Healer Mireen tends the wounded, Ranger Tolk strings his bow, Beastmaster Kurr calms the hounds, Smith Braga mends a shield, and Cook Nessa ladles the stew.')
    ],
    pinText: '',
    relevant: [
      ref('Warband', 0), ref('Warband', 1), ref('Warband', 2), ref('Warband', 3), ref('Warband', 4),
      ref('Warband', 5), ref('Warband', 6), ref('Warband', 7), ref('Warband', 8)
    ],
    hardNegative: [ref('Warband', 9), ref('Warband', 10), ref('Warband', 11)]
  },

  // === Broad-evidence B: a star-chart (14 enabled, 10 relevant @ depth 0/1/2, 4 HN). Deep entries carry
  //     two rare keys so their seed clears the floor/cut robustly despite the recency decay. ===
  {
    name: 'broad-evidence-starchart',
    category: 'broad',
    books: [
      book('StarChart', [
        E({ keys: ['Vega Anchorage'], content: 'A deep-space refuelling depot at the blue star.', comment: 'Vega' }),
        E({ keys: ['Corvid Relay'], content: 'A comms buoy on the trade lane.', comment: 'Corvid' }),
        E({ keys: ['Halcyon Drift'], content: 'A slow river of ice and rock.', comment: 'Halcyon' }),
        E({ keys: ['Umbral Reef'], content: 'A shoal of dead satellites.', comment: 'Umbral' }),
        E({ keys: ['Ferrous Belt'], content: 'A mining belt of iron-rich planetoids.', comment: 'Ferrous' }),
        E({ keys: ['Lantern Array'], content: 'A ring of solar collectors.', comment: 'Lantern' }),
        E({ keys: ['Saffron Gate'], content: 'A jump gate stained by its old star.', comment: 'Saffron' }),
        E({ keys: ['Cobalt Yards'], content: 'The orbital shipwrights.', comment: 'Yards' }),
        // Deep, double-keyed (both keys appear at depth 2) so seed is robust.
        E({ keys: ['Mistral Station', 'the low-orbit hub'], content: 'A weather-monitoring platform.', comment: 'Mistral' }),
        E({ keys: ['Ember Locks', 'the fire canals'], content: 'A chain of thermal locks.', comment: 'Ember' }),
        // Hard negatives — never charted in the transcript.
        E({ keys: ['Requiem Void'], content: 'An unmapped dead zone.', comment: 'Requiem-HN' }),
        E({ keys: ['Ophidian Wake'], content: 'A phantom signal never confirmed.', comment: 'Ophidian-HN' }),
        E({ keys: ['Gilded Marauders'], content: 'A pirate fleet from another sector.', comment: 'Marauders-HN' }),
        E({ keys: ['The Sunless Court'], content: 'A legend of a hidden station.', comment: 'Sunless-HN' })
      ])
    ],
    segments: [
      seg(0, 'We plot a course past Vega Anchorage and the Corvid Relay.'),
      seg(1, 'The Halcyon Drift and Umbral Reef flank the lane; the Ferrous Belt, Lantern Array, Saffron Gate, and Cobalt Yards all report clear.'),
      seg(2, 'Weeks back we logged Mistral Station, the low-orbit hub, and the Ember Locks along the fire canals.')
    ],
    pinText: '',
    relevant: [
      ref('StarChart', 0), ref('StarChart', 1), ref('StarChart', 2), ref('StarChart', 3), ref('StarChart', 4),
      ref('StarChart', 5), ref('StarChart', 6), ref('StarChart', 7), ref('StarChart', 8), ref('StarChart', 9)
    ],
    hardNegative: [ref('StarChart', 10), ref('StarChart', 11), ref('StarChart', 12), ref('StarChart', 13)]
  },

  // === Persistence A (FLOOR): 3 relevant with weak deep evidence (@ depth 3) that fired last floor; 2
  //     equal-scored hard negatives NOT persisted; 1 zero-evidence persisted decoy. 7 enabled → idf≈2.079,
  //     depth-3 base ≈0.449 (< minScore 0.6). persistBoost≥1.5 lifts the persisted relevant over the floor;
  //     the negatives stay floored; the zero-evidence decoy never fires at any boost. ===
  {
    name: 'persistence-fading-companions',
    category: 'persistence',
    books: [
      book('FadingRoad', [
        E({ keys: ['Squire Alden'], content: 'A young shield-bearer from the eastern march.', comment: 'Alden' }),
        E({ keys: ['Groom Pell'], content: 'The one who tends our horses on the road.', comment: 'GroomPell' }),
        E({ keys: ['Herbalist Wynn'], content: 'A wanderer who trades in dried roots.', comment: 'Wynn' }),
        // Equal-scored hard negatives (same depth-3 evidence) but NOT persisted.
        E({ keys: ['the drifter Corvin'], content: 'A stranger met once and never again.', comment: 'Corvin-HN' }),
        E({ keys: ['the tinker Mabb'], content: 'A peddler whose wares we declined.', comment: 'Mabb-HN' }),
        // Zero current evidence, yet listed as fired last floor — must NEVER be resurrected.
        E({ keys: ['Phantom Rider'], content: 'A figure glimpsed in a dream, never real.', comment: 'PhantomRider-ZERO' }),
        // Distractor to fix N at 7 (never mentioned).
        E({ keys: ['Gilded Barge'], content: 'A pleasure boat from a far city.', comment: 'Barge-distractor' })
      ])
    ],
    segments: [
      seg(0, 'We make camp for the night and take stock of the road ahead.'),
      seg(1, 'The way is quiet; nothing stirs in the brush.'),
      seg(3, 'Long ago Squire Alden, Groom Pell, and Herbalist Wynn walked with us, as did the drifter Corvin and the tinker Mabb.')
    ],
    pinText: '',
    relevant: [ref('FadingRoad', 0), ref('FadingRoad', 1), ref('FadingRoad', 2)],
    hardNegative: [ref('FadingRoad', 3), ref('FadingRoad', 4), ref('FadingRoad', 5)],
    prevFired: [ref('FadingRoad', 0), ref('FadingRoad', 1), ref('FadingRoad', 2), ref('FadingRoad', 5)]
  },

  // === Persistence B (CAP): 4 relevant that fired last floor, all @ depth 1 (base ≈1.318); 3 equal-scored
  //     hard negatives NOT persisted with a LOWER insertion_order (so they win score-ties at boost=1); 1
  //     zero-evidence persisted decoy. maxK=4. At boost=1 the tie-break hands the 4 cap slots mostly to the
  //     negatives; at boost≥1.5 the persisted relevant strictly out-score them and take all 4 slots, the
  //     negatives cut by cap. The zero-evidence decoy never fires. ===
  {
    name: 'persistence-recurring-company',
    category: 'persistence',
    books: [
      book('AshenCompany', [
        E({ keys: ['Warden Iyla'], content: 'The steadfast commander of our company.', insertion_order: 50, comment: 'Iyla' }),
        E({ keys: ['Pike-captain Doe'], content: 'She holds the center of every line.', insertion_order: 50, comment: 'Doe' }),
        E({ keys: ['Sapper Renn'], content: 'He clears the walls and sets the charges.', insertion_order: 50, comment: 'Renn' }),
        E({ keys: ['Signaler Kestra'], content: 'Our flags-and-horns officer.', insertion_order: 50, comment: 'Kestra' }),
        // Hard negatives — equal depth-1 evidence, LOWER insertion_order (win ties when scores are equal).
        E({ keys: ['the Bleak Talon raiders'], content: 'A rival band circling for scraps.', insertion_order: 10, comment: 'BleakTalon-HN' }),
        E({ keys: ['Vane the Cutthroat'], content: 'A mercenary of shifting loyalty.', insertion_order: 10, comment: 'Vane-HN' }),
        E({ keys: ['Hollow Sook'], content: 'A skulking opportunist on the flank.', insertion_order: 10, comment: 'Sook-HN' }),
        // Zero current evidence, persisted — must NEVER fire.
        E({ keys: ['the Sunken Herald'], content: 'A messenger lost at sea seasons ago.', insertion_order: 100, comment: 'SunkenHerald-ZERO' })
      ])
    ],
    segments: [
      seg(0, 'We brace for the coming clash at the river ford.'),
      seg(1, 'Warden Iyla rallies Pike-captain Doe, Sapper Renn, and Signaler Kestra as the Bleak Talon raiders, Vane the Cutthroat, and Hollow Sook press the flank.')
    ],
    pinText: '',
    relevant: [ref('AshenCompany', 0), ref('AshenCompany', 1), ref('AshenCompany', 2), ref('AshenCompany', 3)],
    hardNegative: [ref('AshenCompany', 4), ref('AshenCompany', 5), ref('AshenCompany', 6)],
    prevFired: [
      ref('AshenCompany', 0), ref('AshenCompany', 1), ref('AshenCompany', 2), ref('AshenCompany', 3),
      ref('AshenCompany', 7)
    ]
  }
]

/** The full evaluation suite: original tuned scenarios + the new broad-evidence / persistence ones. */
export const SCENARIOS: Scenario[] = [...ORIGINAL_SCENARIOS, ...NEW_SCENARIOS]

/** Look up a scenario by name (throws if absent — keeps the regression test honest). */
export const scenario = (name: string): Scenario => {
  const s = SCENARIOS.find((x) => x.name === name)
  if (!s) throw new Error(`unknown scenario: ${name}`)
  return s
}
