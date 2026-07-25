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
const PERSIST_BROAD_SCENARIOS: Scenario[] = [
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

// ===================================================================================================
// STRUCTURAL SCENARIOS (2026-07-24) — four families that fix three measured defects of the 23-scenario
// suite: (a) no recall headroom (baseline micro-recall was exactly 1.000, so no knob could ever GAIN
// recall), (b) depth 0 mis-modeled (10 of 23 put ALL evidence at depth 0; the real product has a ~40-char
// pending action competing with ~9,700 chars of transcript at depths 1-3), (c) wrong scale regime
// (synthetic books held 12-20 entries; the real book has 331 enabled entries, so maxK=12 never bound).
//
// CLEAN-ROOM: every name, key, comment, and prose string below is original, authored for this harness.
// Nothing is copied or paraphrased from any card, ST preset, or third-party lorebook.
//
// Scoring facts these families lean on (verified against src/main/services/loreScoring.ts):
//   idf(k) = ln(1 + N/df(k)); df counts ENABLED entries whose CONTENT matches k or that declare k
//   verbatim, so df >= 1 always and idf <= ln(1+N), idf >= ln(2) ~ 0.693. A depth-0 single-key hit at
//   actionBoost 1 therefore scores >= 0.693 and can NEVER be stopped by minScore 0.6 — the only lever
//   that can suppress a depth-0 hit is the RELATIVE cut (relCut * topScore). That is why the topic-pivot
//   family is built around relCut rather than the floor.
// ===================================================================================================

/** Deterministic filler for the `scale` family: `count` entries with unique, rare keys that appear in NO
 *  transcript (seed 0 → they never fire and, having seed 0, never donate a one-hop link bonus either).
 *  `contentTail` is appended verbatim to every filler body — that is how a generic word is given a high
 *  document frequency (and therefore a low idf). No Math.random: index-derived only. */
const scaleFiller = (
  prefix: string,
  count: number,
  contentTail: string,
  startOrder: number
): LorebookEntry[] =>
  Array.from({ length: count }, (_, i) =>
    E({
      keys: [`${prefix} Folio ${i}`],
      content: `Folio ${i} of the ${prefix} stacks, a minor holding of no present bearing.${contentTail}`,
      comment: `${prefix}-filler-${i}`,
      insertion_order: 500 + startOrder + i
    })
  )

// --- book-at-scale-archive: hand-placed relevant entries, as [primary key, alias key] pairs. ---
const ARCHIVE_D0 = ['Sablecourt Charter', 'Hollowpine Deed']
const ARCHIVE_D1: Array<[string, string]> = [
  ['Ashvault Ledger', 'the ash tallies'],
  ['Greenmarch Survey', 'the march chains'],
  ['Kestrel Assize Roll', 'the assize hand'],
  ['Thornmill Indenture', 'the mill bond'],
  ['Saltgate Manifest', 'the gate lading'],
  ['Winterhold Rent-book', 'the winter rents']
]
const ARCHIVE_D2: Array<[string, string]> = [
  ['Fenwick Cartulary', 'the fen copies'],
  ['Oxbow Terrier', 'the oxbow bounds'],
  ['Marlstone Quitclaim', 'the marl release'],
  ['Bramblewick Fine', 'the bramble fine'],
  ['Redlark Pipe Roll', 'the redlark pipes'],
  ['Stonewell Extent', 'the well extent']
]

/** book-at-scale-hub: the 22 annex keys the hub entry's CONTENT names verbatim (A..V). Each annex has
 *  ZERO evidence of its own — its whole score is the one-hop bonus borrowed from the hub. */
const HUB_ANNEX_KEYS = Array.from({ length: 22 }, (_, i) => `Ledgerhall Annex ${String.fromCharCode(65 + i)}`)

const HUB_D1_KEYS = [
  'Verity Stacks Case',
  'Ambergate Sublease',
  'Northwold Fee-book',
  'Pellum Bridge Award',
  'Halloway Escheat'
]
const HUB_D2_KEYS: Array<[string, string]> = [
  ['Cranemoor Attainder', 'the crane writ'],
  ['Bexley Quitrent', 'the bexley rents'],
  ['Sarn Hollow Grant', 'the hollow grant'],
  ['Idlewharf Compact', 'the wharf compact'],
  ['Marrowgate Assize', 'the marrow assize']
]

/** Never-mentioned padding used to fix N (and therefore idf) in the small hand-written books. */
const padding = (prefix: string, count: number): LorebookEntry[] =>
  Array.from({ length: count }, (_, i) =>
    E({
      keys: [`${prefix} Aside ${i}`],
      content: `An unrelated aside, number ${i}, recorded out of habit.`,
      comment: `${prefix}-pad-${i}`
    })
  )

export const STRUCTURAL_SCENARIOS: Scenario[] = [
  // =================================================================================================
  // FAMILY 1 — topic-pivot. A SHORT depth-0 action names a subject that appears NOWHERE in the long
  // depth-1..3 transcript. The pivot entry is reachable ONLY through the depth-0 evidence.
  // =================================================================================================

  // --- topic-pivot A. Harrowgate: N=14 enabled → idf(df=1)=ln(15)=2.7081, idf(df=2)=ln(8)=2.0794.
  //     The two scene entries carry 5 keys each, all hit at depth 1 (weight lambda=0.6), and name each
  //     other in content, so each also takes a one-hop bonus of hopDecay(0.5) x the other's seed:
  //       seed = 0.6 x (4x2.7081 + 2.0794) = 7.747  →  final = 7.747 x 1.5 = 11.62 (topScore)
  //     The pivot entry has ONE rare key hit only at depth 0:
  //       actionBoost 1 → 2.7081, and relCut floor = 0.35 x 11.62 = 4.067  →  CUT, DOES NOT FIRE.
  //       actionBoost 2 → 5.416 ≥ 4.067 → fires; actionBoost 3 → 8.124 → fires.
  //     INTENDED BASELINE OUTCOME: recall 2/3 at DEFAULT_SCORING_PARAMS (the two scene entries fire, the
  //     pivot does not). This is the recall headroom the old suite lacked. The flip point is actionBoost
  //     ≈ 1.5; it is comfortably fired by the required actionBoost ≥ 3.
  //     The two stale entries are named ONLY at depth 3 (0.216 x 2.7081 = 0.585 < minScore 0.6 → floored).
  {
    name: 'topic-pivot-harrowgate-writ',
    category: 'pivot',
    books: [
      book('Harrowgate', [
        E({
          keys: [
            'Warden Calloway',
            'the Grey Warden',
            'the curtain-wall command',
            'the Third Company',
            'the dawn rampart'
          ],
          content:
            'The stern officer who holds the upper wall. She defers to the Bellhouse Muster in all matters of levy.',
          comment: 'Calloway'
        }),
        E({
          keys: [
            'Bellhouse Muster',
            'the muster bell',
            'the levy roll',
            'the Fourth Banner',
            'the lower yard files'
          ],
          content:
            'The town levy forms in ragged files. Its rolls are countersigned by the Grey Warden before any march.',
          comment: 'Bellhouse'
        }),
        // The PIVOT. Named only by the depth-0 action; no content anywhere names it, so it takes no
        // link bonus either.
        E({
          keys: ['Sablewing Writ'],
          content: 'A sealed decree of passage, rarely invoked and never yet revoked.',
          comment: 'SablewingWrit-PIVOT'
        }),
        // Stale: named only at depth 3. Strong-looking in the transcript, irrelevant to the pivot.
        E({ keys: ['Emberford Crossing'], content: 'A shallow ford abandoned after the flood.', comment: 'Emberford-HN' }),
        E({ keys: ['the salt tithe'], content: 'A levy on preserved fish, resented by all.', comment: 'SaltTithe-HN' }),
        ...padding('Harrowgate', 9)
      ])
    ],
    segments: [
      seg(0, 'I ask the archivist about the Sablewing Writ.'),
      seg(
        1,
        'Warden Calloway is already on the dawn rampart when the horns sound, counting the gaps where the winter rains tore the earthworks open. The Grey Warden — the garrison still uses the old title, though it lapsed two reigns ago — has not slept since the beacons went up along the western ridge, and the curtain-wall command answers to her alone. The Third Company has stood double watches for nine days and it shows in every slouched shoulder. Below, the Bellhouse Muster is forming: the lower yard files stretch from the smithy to the cistern, the muster bell has rung twice already, and the levy roll is still forty names short of what the charter demands. The Fourth Banner leans unclaimed against the gatehouse, its cloth stiff with old rain, while two underclerks argue about whether it flies today or waits for the reeve.'
      ),
      seg(
        2,
        'Rain came in off the moor before noon and turned the yard to a grey soup. The cooks gave up on the open fires and dragged everything under the awning, where the smoke had nowhere to go and everyone coughed and pretended not to. A boy slipped on the cistern steps and broke a jar; nobody scolded him. Somebody had begun a song about a girl and a boat and forgot the middle of it, and for a while the only sounds were the drip off the eaves and the scrape of a whetstone. It was the kind of afternoon that made the whole siege feel like a rumour, until the horns went again at dusk and the whole yard remembered where it was standing.'
      ),
      seg(
        3,
        'Weeks before any of this, we came up the valley by way of Emberford Crossing, wading the shallows with the packs held over our heads because the bridge had been down since spring. On the far bank a clerk in a wet cloak demanded the salt tithe, and when we said we carried no fish he demanded it anyway, on the grounds that we might have. We paid him in copper and bad temper and slept in a barn that leaked. In the morning the crossing was a brown torrent and the clerk was gone, and we never learned whether the tithe was real or whether he had simply invented a way to eat that week. It hardly seemed to matter by the time we reached the gate.'
      )
    ],
    pinText: '',
    relevant: [ref('Harrowgate', 0), ref('Harrowgate', 1), ref('Harrowgate', 2)],
    hardNegative: [ref('Harrowgate', 3), ref('Harrowgate', 4)]
  },

  // --- topic-pivot B. Tideholm: N=18 → idf(df=1)=ln(19)=2.9444, idf(df=2)=ln(10)=2.3026.
  //     Same shape as A, but the pivot key is DAMPED: three other entries name 'Gullwing Charter' in
  //     their CONTENT, so df=4 → idf = ln(1 + 18/4) = ln(5.5) = 1.7047. Those three donors have zero
  //     seed (their own keys are never in the transcript), so the pivot gets no link bonus from them.
  //       scene entries: seed = 0.6 x (4x2.9444 + 2.3026) = 8.448 → final 12.672 (topScore)
  //       relCut floor  = 0.35 x 12.672 = 4.435
  //       pivot @ actionBoost 1 → 1.705  (CUT)   2 → 3.409  (CUT)   3 → 5.114 ≥ 4.435 → FIRES
  //     INTENDED BASELINE OUTCOME: recall 2/3 at defaults; the flip point is actionBoost ≈ 2.6, so this
  //     scenario needs the full actionBoost 3 and not merely 2.
  {
    name: 'topic-pivot-tideholm-charter',
    category: 'pivot',
    books: [
      book('Tideholm', [
        E({
          keys: [
            'Harbourmaster Quillon',
            'the tide-office',
            'the wharf writ-book',
            'the Second Quay',
            'the ebb roster'
          ],
          content:
            'He keeps the harbour by the hour. His counterpart at the Slipgate Yard signs the same manifests.',
          comment: 'Quillon'
        }),
        E({
          keys: [
            'Slipgate Yard',
            'the careening slip',
            'the tar sheds',
            'the Third Slipway',
            'the yard bell'
          ],
          content:
            'Hulls come out of the water here. The tide-office sends its clerks down at every low water.',
          comment: 'Slipgate'
        }),
        // The PIVOT (df=4 → damped idf 1.7047).
        E({
          keys: ['Gullwing Charter'],
          content: 'A trading licence granted to a single house and never yet transferred.',
          comment: 'GullwingCharter-PIVOT'
        }),
        // Three ZERO-SEED entries whose content names the pivot key — they raise df (damping the pivot's
        // idf) without donating any link bonus, because a donor needs seed > 0 to spread activation.
        E({ keys: ['the Copperline Guild'], content: 'A guild that once petitioned against the Gullwing Charter.', comment: 'Copperline-df' }),
        E({ keys: ['the Assay Bench'], content: 'Where the Gullwing Charter seals were last verified.', comment: 'Assay-df' }),
        E({ keys: ['Notary Fenwick'], content: 'He filed the Gullwing Charter and remembers nothing else.', comment: 'Notary-df' }),
        // Stale: named only at depth 3.
        E({ keys: ['Bracken Roads'], content: 'A cart route through the heath, long since rutted.', comment: 'Bracken-HN' }),
        E({ keys: ['the pilot fee'], content: 'A charge for guiding hulls past the bar.', comment: 'PilotFee-HN' }),
        ...padding('Tideholm', 10)
      ])
    ],
    segments: [
      seg(0, 'I ask the clerk to find the Gullwing Charter.'),
      seg(
        1,
        'Harbourmaster Quillon has the tide-office open before the gulls are up, and by the time the first hull warps in he has already lost his temper twice. The wharf writ-book lies open on the sill with a stone on it against the wind, and every third line has been struck through and written again in a smaller hand. The Second Quay is fouled with a grain hulk that will not move until its factor pays, and the ebb roster says four more are due before the water turns. Down at the Slipgate Yard the careening slip is empty for the first time in a month; the tar sheds are open to air out, the Third Slipway has a keel on it that nobody will admit to owning, and the yard bell rings the half-hours whether or not anyone is listening for them.'
      ),
      seg(
        2,
        'The fog did not lift until well past noon, and while it sat on the water everything sounded closer than it was. Somewhere out in the roads a bell buoy kept time badly. Two boys were selling hot chestnuts off a brazier at the head of the steps and doing better trade than any of the honest merchants, and a dog with one ear had attached itself to them on the theory that generosity is contagious. An old woman mended net in a doorway and told anyone who slowed down that the weather had been worse in her mother year, which may have been true and was certainly unanswerable. Nothing happened for three hours, and then the fog went and the whole harbour started shouting at once.'
      ),
      seg(
        3,
        'We had come down out of the hills that season by the Bracken Roads, which are roads only in the sense that carts have been dragged along them before. The ruts were axle-deep and full of standing water, and twice we had to unload the whole cart to get it over a rise. At the bottom a man with a ledger took the pilot fee off us for a stretch of river we had not yet reached and did not intend to use, and when we objected he explained, patiently, that the fee was for the right to object. We paid it. The hills behind us went blue and then black, and we did not think about that road again until somebody mentioned it tonight.'
      )
    ],
    pinText: '',
    relevant: [ref('Tideholm', 0), ref('Tideholm', 1), ref('Tideholm', 2)],
    hardNegative: [ref('Tideholm', 6), ref('Tideholm', 7)]
  },

  // =================================================================================================
  // FAMILY 2 — realistic-proportions. A ~40-60 char depth-0 pending action against three 800+ char
  // narrative segments at depths 1/2/3. Relevant entries are split between the ACTION topic and the
  // ONGOING scene, so the depth weighting (lambda) is genuinely measurable instead of a uniform scale.
  // =================================================================================================

  // --- Riverwatch: N=18 → idf(df=1)=ln(19)=2.9444. No entry's content names another's key, so there are
  //     no link bonuses anywhere: every score here is pure depth-weighted key evidence.
  //       action entry  (1 key @ depth 0) = 2.944
  //       scene entries (2 keys @ depth 1) = 1.2 x 2.9444 = 3.533  ← topScore
  //       scene entries (2 keys @ depth 2) = 0.72 x 2.9444 = 2.120
  //       stale entries (1 key @ depth 3) = 0.216 x 2.9444 = 0.636 → above minScore 0.6 but below the
  //         relCut floor 0.35 x 3.533 = 1.237, so they are CUT, not floored.
  {
    name: 'realistic-proportions-riverwatch',
    category: 'proportions',
    books: [
      book('Riverwatch', [
        E({ keys: ['Marrowglass Vial'], content: 'A stoppered phial of clouded glass; its contents are never named twice.', comment: 'MarrowglassVial-ACTION' }),
        E({ keys: ['Sergeant Ombra', 'the pontoon works'], content: 'She runs the bridging crews and tolerates no idlers.', comment: 'Ombra' }),
        E({ keys: ['Nettlebank Ford', 'the ford pickets'], content: 'A shallow crossing watched day and night.', comment: 'Nettlebank' }),
        E({ keys: ['the Ninth Signal Post', 'the shutter-lamp code'], content: 'A relay tower on the ridge that speaks in light.', comment: 'NinthSignal' }),
        E({ keys: ['Quartermaster Vell', 'the wet-stores tally'], content: 'He counts every sack twice and trusts no one.', comment: 'Vell' }),
        E({ keys: ['the Copperjack Barge', 'the barge crews'], content: 'A flat-bottomed hauler that works the slow water.', comment: 'Copperjack' }),
        E({ keys: ['Ashenmoor Crossing'], content: 'A ford lost to the spring melt two years running.', comment: 'Ashenmoor-HN' }),
        E({ keys: ['the Bitterwind Toll'], content: 'A gate charge nobody has collected since the war.', comment: 'BitterwindToll-HN' }),
        ...padding('Riverwatch', 10)
      ])
    ],
    segments: [
      // ~43 chars: the pending user action, exactly as the real product presents depth 0.
      seg(0, 'I unseal the Marrowglass Vial and study it.'),
      seg(
        1,
        'Sergeant Ombra has the pontoon works strung out across the shallows before the light is good enough to see the far bank, and she is not in a mood to explain herself twice. Three of the floats have taken water overnight and the ropes have swollen so tight that they have to be cut rather than untied, which puts everyone behind and everyone in a temper. Up at Nettlebank Ford the ford pickets have been doubled since the tracks were found on the gravel, and the corporal there has developed the habit of counting the far treeline out loud, which is doing nothing for anyone nerves. On the ridge, the Ninth Signal Post has been flashing since first light; the shutter-lamp code came through garbled twice and clean on the third try, and what it said was that we should hold where we are and expect nothing before nightfall.'
      ),
      seg(
        2,
        'Yesterday was all accounting and no soldiering, which is its own kind of exhausting. Quartermaster Vell set himself up under the awning with the wet-stores tally and refused to release so much as a sack of meal until every line balanced, which took until the middle of the afternoon and made him no friends at all. Twice he made a corporal carry the same barrel back and forth because the number chalked on the lid did not match the number in his book, and both times the book turned out to be right, which only made it worse. Late in the day the Copperjack Barge came up on the slow water with the last of the winter stores, and the barge crews unloaded in the rain without being asked, then sat on the bank eating cold porridge and telling everyone who passed that they had done it out of the goodness of their hearts.'
      ),
      seg(
        3,
        'It had been a different country when we came up this valley in the spring. There was still snow in the gullies and the whole army moved at the speed of its slowest cart, which is to say hardly at all. We came over at Ashenmoor Crossing, which the maps still show as a ford and which has not been one since the melt took the gravel bar two years running; we got the carts over on planks and lost a mule doing it. On the far side a man with a strongbox tried to charge us the Bitterwind Toll, a gate charge nobody has collected since the war, and was so surprised to be refused that he simply stood there watching us go. We lost a week to a bridge that turned out to be sound and another to one that turned out not to be. Somebody had painted a hopeful mile-count on a rock at the head of the pass and it was wrong by half. In the evenings the officers argued about routes over a map folded so often the creases went through three of the towns, and in the mornings they set off in whichever direction the ground allowed.'
      )
    ],
    pinText: '',
    relevant: [
      ref('Riverwatch', 0), ref('Riverwatch', 1), ref('Riverwatch', 2),
      ref('Riverwatch', 3), ref('Riverwatch', 4), ref('Riverwatch', 5)
    ],
    hardNegative: [ref('Riverwatch', 6), ref('Riverwatch', 7)]
  },

  // --- Emberlane: same proportions, but entry 6 is a GENUINELY relevant standing agreement that the
  //     scene rests on and that is only restated at depth 3 (0.636 < relCut floor 1.237 → CUT). It is
  //     listed as relevant on purpose: at DEFAULT_SCORING_PARAMS recall here is 6/7, which is real
  //     headroom a lambda / depth-weighting change can recover. Entry 7 is the matched hard negative —
  //     identical depth-3 evidence, genuinely dead.
  {
    name: 'realistic-proportions-emberlane',
    category: 'proportions',
    books: [
      book('Emberlane', [
        E({ keys: ['the Ashwright Token'], content: 'A pressed tin disc that buys silence in the right hands.', comment: 'AshwrightToken-ACTION' }),
        E({ keys: ['Broker Sennah', 'the third stall row'], content: 'She sells what other people have not yet lost.', comment: 'Sennah' }),
        E({ keys: ['the Glasswing Consortium', 'the consortium seal'], content: 'Four houses that price the whole lane between them.', comment: 'Glasswing' }),
        E({ keys: ['Nightwarden Ossa', 'the lamp patrol'], content: 'He keeps order after the lamps are lit, mostly.', comment: 'Ossa' }),
        E({ keys: ['the Coldcellar Exchange', 'the cellar ledger'], content: 'Where perishable goods are traded before dawn.', comment: 'Coldcellar' }),
        E({ keys: ['Runner Ives', 'the runner whistles'], content: 'The fastest of the message boys, and the dearest.', comment: 'Ives' }),
        E({ keys: ['the Vetch Street Compact'], content: 'The standing truce that lets rival stalls share a lane.', comment: 'VetchCompact-DEEP-RELEVANT' }),
        E({ keys: ['the Tallowgate Levy'], content: 'A gate charge repealed three winters ago.', comment: 'TallowgateLevy-HN' }),
        ...padding('Emberlane', 10)
      ])
    ],
    segments: [
      // ~46 chars.
      seg(0, 'I press the Ashwright Token into her palm.'),
      seg(
        1,
        'Broker Sennah keeps her pitch at the near end of the third stall row, where the lamps are good and the ground does not flood, and she has held it for eleven years by a combination of charm and other means. Tonight she is short with everyone, which usually means she has already sold something she should not have. Two stalls down, a factor of the Glasswing Consortium is going along the row with a slate, marking prices that the traders will pretend to argue with and then accept, because the consortium seal on a crate is worth more than whatever is inside it. Nightwarden Ossa drifts through around the ninth bell with the lamp patrol at his back, looking at nothing in particular and seeing most of it, and the lane goes quiet in a rolling wave in front of him and loud again behind, the way it does every night of the year.'
      ),
      seg(
        2,
        'Before the lamps went up we had spent most of the small hours down at the Coldcellar Exchange, which is a cellar in the same way a cathedral is a room. Everything that will spoil by evening changes hands there between the third and fifth bells, and the cellar ledger is kept in a hand so cramped that only two people alive can read it, one of whom is dead. We waited for a price that never came and drank something hot and dubious out of tin cups. Runner Ives found us there at the turn of the hour with a message we had not asked for and a bill for delivering it; the runner whistles were going up and down the stairwell the whole time, three short and one long, which nobody would explain and everybody clearly understood. We left before the fifth bell with nothing bought and nothing sold, which the cellar treats as a kind of failure of nerve, and climbed the stairs into a street that was already grey at the edges. Somebody was sweeping fish scales into the gutter and singing about it.'
      ),
      seg(
        3,
        'None of this would be possible at all without the Vetch Street Compact, which is why the older traders still recite it at the turn of the season the way other people recite prayers. Rival stalls share a lane, no blade is drawn between the lamps, and any grievance waits for the market court — that is the whole of it, and it has held, more or less, since the fire year. There was a time before it. The Tallowgate Levy belongs to that time too: a charge on every barrow through the north gate, collected by men who kept most of it, repealed three winters ago by a council that wanted to look generous and has not looked generous since. The old-timers mention both in the same breath, though only one of them still binds anybody, and the younger traders have started to mix the two up entirely. Ask three of them what the compact actually says and you will get three answers, all confident, none complete. That has not stopped it working.'
      )
    ],
    pinText: '',
    relevant: [
      ref('Emberlane', 0), ref('Emberlane', 1), ref('Emberlane', 2), ref('Emberlane', 3),
      ref('Emberlane', 4), ref('Emberlane', 5), ref('Emberlane', 6)
    ],
    hardNegative: [ref('Emberlane', 7)]
  },

  // =================================================================================================
  // FAMILY 3 — book-at-scale. 150+ enabled entries so maxK=12 is the BINDING constraint, as it is
  // against the real 331-entry lorebook.
  // =================================================================================================

  // --- Archive: 150 filler + 14 relevant + 10 generic-key hard negatives = 174 enabled.
  //     idf(df=1) = ln(175) = 5.1648.
  //     Relevant: 2 @ depth 0 (1 key → 5.165), 6 @ depth 1 (2 keys → 1.2 x 5.165 = 6.198, topScore),
  //     6 @ depth 2 (2 keys → 0.72 x 5.165 = 3.719). relCut floor = 0.35 x 6.198 = 2.169, so ALL 14
  //     clear the floor and the cut — and maxK=12 then has to leave 2 of them out. Baseline recall 12/14.
  //     Hard negatives are keyed on 'the outer vault', which every one of the 150 filler bodies contains:
  //     df = 150 (filler content) + 10 (declaring entries) = 160 → idf = ln(1 + 174/160) = 0.7360;
  //     at depth 1 that is 0.6 x 0.7360 = 0.4416 < minScore 0.6 → FLOORED. The filler donors all have
  //     seed 0, so the generic entries take no link bonus either.
  {
    name: 'book-at-scale-archive',
    category: 'scale',
    books: [
      book('RidgewayArchive', [
        ...scaleFiller('Ridgeway', 150, ' Stored in the outer vault.', 0),
        // 150..151 — relevant, named by the depth-0 pending action.
        ...ARCHIVE_D0.map((k) =>
          E({ keys: [k], content: `A muniment of the old honour, kept flat and unfolded.`, comment: `${k}-D0` })
        ),
        // 152..157 — relevant, named at depth 1.
        ...ARCHIVE_D1.map(([k, alias]) =>
          E({ keys: [k, alias], content: `A working record of the estate, consulted most weeks.`, comment: `${k}-D1` })
        ),
        // 158..163 — relevant, named at depth 2.
        ...ARCHIVE_D2.map(([k, alias]) =>
          E({ keys: [k, alias], content: `An older record, still cited when a boundary is disputed.`, comment: `${k}-D2` })
        ),
        // 164..173 — generic-key hard negatives (df 160 → idf 0.736 → floored at depth 1).
        ...Array.from({ length: 10 }, (_, i) =>
          E({
            keys: ['the outer vault', `Vault Warden ${i}`],
            // Body deliberately OMITS the shared key (as `thin-evidence-opening` does): otherwise these
            // ten entries donate one-hop bonuses to each other and climb back over the floor.
            content: `Shelf ${i} beneath the north stair, dusted twice a year.`,
            comment: `OuterVault-HN-${i}`
          })
        )
      ])
    ],
    segments: [
      // ~57 chars.
      seg(0, `I call up the ${ARCHIVE_D0[0]} and the ${ARCHIVE_D0[1]}.`),
      seg(
        1,
        `The reading room stays open past the ninth bell tonight because the commissioners want everything on the table by morning. Underclerks carry up the ${ARCHIVE_D1.map(([k]) => k).join(', the ')}, one box at a time, and the duty archivist checks each against its cross-reference — ${ARCHIVE_D1.map(([, a]) => a).join(', ')} — before any seal is broken. Two of the boxes come back down again unopened because their tags do not match the day list, which the archivist notes in the margin with visible satisfaction. Everything else in the building is sitting in the outer vault where it has sat since the last commission, and nobody has proposed disturbing it.`
      ),
      seg(
        2,
        `Last week the same room was given over to the older material, which is heavier and smells worse and has to be handled with both hands. We worked through the ${ARCHIVE_D2.map(([k]) => k).join(', the ')} in the order the catalogue gave them, which is not the order anyone would choose, and we made our own list as we went: ${ARCHIVE_D2.map(([, a]) => a).join(', ')}. Three of them had been rebound at some point by somebody who did not care what order the leaves went back in. The archivist has a theory about who and will tell you at length. By the end of it we had four pages of notes and a strong sense that the boundary question was settled twice, differently, by the same court.`
      ),
      seg(
        3,
        'Long before any of this the whole collection was kept in a barn, which is a thing the current staff say the way other people confess to a family scandal. There was a leak. There was, at one point, a goat. Roughly a third of the earliest material simply does not exist any more and the gaps are recorded in a slim volume that reads like a casualty list. Nobody who was responsible is still alive to be blamed, which has not stopped two generations of archivists from blaming them thoroughly and by name at every opportunity, usually over the second glass.'
      )
    ],
    pinText: '',
    relevant: Array.from({ length: 14 }, (_, i) => ref('RidgewayArchive', 150 + i)),
    hardNegative: Array.from({ length: 10 }, (_, i) => ref('RidgewayArchive', 164 + i))
  },

  // --- Hub: 150 filler + 1 hub + 22 annexes + 10 relevant = 183 enabled. idf(df=1) = ln(184) = 5.2149.
  //     The HUB's content names the keys of 22 OTHER entries verbatim — a real hub, which is exactly what
  //     `linkCap` exists for. Its own evidence is 1 key @ depth 0 + 1 key @ depth 1:
  //       hub seed  = 5.2149 x (1 + 0.6) = 8.344   (topScore; nothing names the hub, so no bonus back)
  //       annexes   = hopDecay 0.5 x 8.344 = 4.172 EACH, borrowed entirely — their own seed is ZERO.
  //       relevant  = 0.6 x 5.2149 = 3.129 (depth 1, 1 key) / 0.72 x 5.2149 = 3.755 (depth 2, 2 keys)
  //       relCut floor = 0.35 x 8.344 = 2.920 → every relevant entry CLEARS the floor and the cut …
  //     … but the 22 zero-evidence annexes out-score all of them, so at maxK=12 the cap is spent on the
  //     hub + 11 annexes and every other relevant entry is cut by `cap`. Baseline recall 1/11 with 11
  //     hard-negative violations. At linkCap=1 the annexes borrow min(4.172, 1 x 0) = 0, fire nothing,
  //     and the hub + all 10 relevant entries fire (recall 1.0, 0 violations). That contrast is the point.
  {
    name: 'book-at-scale-hub',
    category: 'scale',
    books: [
      book('LedgerhallRegistry', [
        ...scaleFiller('Ledgerwood', 150, '', 0),
        // 150 — the HUB. Its content names all 22 annex keys.
        E({
          keys: ['the Ledgerhall registry', 'the great roof index'],
          content: `The registry indexes every annex under the great roof: ${HUB_ANNEX_KEYS.join(', ')}.`,
          comment: 'LedgerhallHub'
        }),
        // 151..172 — the 22 annexes. ZERO own evidence; pure link-bonus passengers.
        ...HUB_ANNEX_KEYS.map((k, i) =>
          E({
            keys: [k],
            content: 'A shelving annex holding tallies, receipts, and little else.',
            comment: `Annex-HN-${i}`,
            insertion_order: 300 + i
          })
        ),
        // 173..177 — relevant, named at depth 1 (one key each).
        ...HUB_D1_KEYS.map((k) =>
          E({ keys: [k], content: 'A live matter, still before the court this term.', comment: `${k}-D1` })
        ),
        // 178..182 — relevant, named at depth 2 (two keys each).
        ...HUB_D2_KEYS.map(([k, alias]) =>
          E({ keys: [k, alias], content: 'A matter adjourned last term and not yet resumed.', comment: `${k}-D2` })
        )
      ])
    ],
    segments: [
      // ~50 chars.
      seg(0, 'I pull the Ledgerhall registry for the annex count.'),
      seg(
        1,
        `The great roof index is out on the long table again because nobody can agree what is still live and what is merely unclosed. This term the clerks are working through the ${HUB_D1_KEYS.join(', the ')}, in that order, and each of them has been listed, struck, and relisted at least once since midsummer. The senior clerk reads the head of each matter aloud and waits to see whether anyone objects; mostly nobody does, and the ones that draw an objection are set aside in a pile that has been growing since the second week. By the ninth bell the table is more paper than table and somebody has begun stacking upward, which is against every rule the room has.`
      ),
      seg(
        2,
        `Last term ran the other way: everything was adjourned and nothing was resolved. The ${HUB_D2_KEYS.map(([k]) => k).join(', the ')} all went over to this term on the same morning, and the clerks noted them in the short forms they use among themselves — ${HUB_D2_KEYS.map(([, a]) => a).join(', ')} — because writing the full heads out four times each had stopped being tolerable. Two of them had already been adjourned twice. There is an argument, made every few years by somebody new, that a matter adjourned three times should simply lapse; it is always defeated by the observation that half the registry would vanish overnight.`
      ),
      seg(
        3,
        'The building itself is older than anything in it. Three of the outer walls belong to a hall that burned, and the roof that gives the index its name was raised over the ruin by a benefactor whose name is carved in a place nobody can see without a ladder. The floor slopes badly toward the north end, which is why the heavy presses are all at the south end, which is why the north end is where anyone goes to think. In winter the whole place smells of wet stone and lamp oil and the particular dust that only comes off old vellum, and the staff will tell you, without being asked, that they prefer it to anywhere else they have worked.'
      )
    ],
    pinText: '',
    relevant: [
      ref('LedgerhallRegistry', 150),
      ...Array.from({ length: 10 }, (_, i) => ref('LedgerhallRegistry', 173 + i))
    ],
    hardNegative: Array.from({ length: 22 }, (_, i) => ref('LedgerhallRegistry', 151 + i))
  },

  // =================================================================================================
  // FAMILY 4 — generic-key-distractor. Entries keyed on a high-df generic word must LOSE to a low-df
  // topical match. (The real-world failure was keys like "person" / "environment" carrying df 227 and
  // 116 of 331 enabled entries.) In both scenarios the generic word appears in MANY entry BODIES, which
  // is what actually drives df — declaring the key on ten entries alone would not be enough.
  // =================================================================================================

  // --- Settlement: N = 42 enabled (1 topical @ depth 0, 1 topical @ depth 1, 8 generic, 32 filler).
  //     INTENDED df('settlement') = 40: the 32 filler bodies contain it, plus the 8 entries that declare
  //     it. → idf = ln(1 + 42/40) = ln(2.05) = 0.7178. Note this is ABOVE minScore 0.6, so at depth 0 the
  //     generic entries are NOT floored (0.7178 > 0.6) — they are killed by the RELATIVE cut:
  //       topScore = the depth-1 two-key topical entry = 1.2 x ln(43) = 1.2 x 3.7612 = 4.513
  //       relCut floor = 0.35 x 4.513 = 1.580  >  0.7178  → all 8 generic entries CUT.
  //     The rare topical key at depth 0 scores 3.761 and fires. Every filler donor has seed 0, so the
  //     generic entries take no link bonus from the 32 bodies that mention them.
  {
    name: 'generic-key-settlement',
    category: 'generickey',
    books: [
      book('Hollowbrook', [
        E({ keys: ['Hollowbrook Cistern'], content: 'A vaulted rain-catch beneath the old quarter, still sweet.', comment: 'Cistern-TOPICAL' }),
        E({ keys: ['Quillwright Almshouse', 'the alms roll'], content: 'Twelve beds, four of them always empty by custom.', comment: 'Almshouse-TOPICAL' }),
        ...Array.from({ length: 8 }, (_, i) =>
          E({
            keys: ['settlement', `Hearthward ${i}`],
            // Body omits the shared key so these eight do not donate one-hop bonuses to each other.
            content: `Hearth ${i} of the lower quarter, tallied at the spring count.`,
            comment: `Settlement-HN-${i}`
          })
        ),
        ...Array.from({ length: 32 }, (_, i) =>
          E({
            keys: [`Bywater Note ${i}`],
            content: `Note ${i}: a minor matter of the settlement, recorded and forgotten.`,
            comment: `Hollowbrook-filler-${i}`,
            insertion_order: 500 + i
          })
        )
      ])
    ],
    segments: [
      // ~52 chars — the generic word rides along in the pending action itself.
      seg(0, 'We open the Hollowbrook Cistern under the settlement.'),
      seg(
        1,
        'Earlier the whole afternoon went on the Quillwright Almshouse, which needs a new roof and will not get one this year. The alms roll has not been revised since the old warden died, so four of the names on it belong to people who have not been seen in a decade and two belong to people who are demonstrably dead, and none of them can be struck off without a sitting of the vestry. The vestry has not sat since spring. In the meantime the almoner distributes the same bread to the same nine faces and writes down twelve, which everyone knows about and nobody has found a way to fix that does not begin with somebody admitting fault.'
      ),
      seg(
        2,
        'The rest of the week has been quiet in the way that makes people uneasy rather than restful. The mill is down for its annual stripping, the carters are between contracts, and the only excitement was a dispute over a boundary hedge that ended, as these things do, with both parties agreeing loudly that the hedge should never have been planted. Rain most nights. Somebody heard something on the road two nights back and by the following evening it had become three riders and a lantern, which by the evening after that had become nothing at all again.'
      )
    ],
    pinText: '',
    relevant: [ref('Hollowbrook', 0), ref('Hollowbrook', 1)],
    hardNegative: Array.from({ length: 8 }, (_, i) => ref('Hollowbrook', 2 + i))
  },

  // --- Guardian: N = 62 enabled (2 topical, 10 generic, 30 'guardian'-bearing filler, 20 plain filler).
  //     INTENDED df('guardian') = 40: 30 filler bodies + the 10 entries that declare it — deliberately
  //     the same ~116-of-331 proportion the real book showed. → idf = ln(1 + 62/40) = ln(2.55) = 0.9361.
  //     Here the generic word appears only at DEPTH 1, so the FLOOR is the mechanism (contrast with the
  //     settlement scenario, where the relative cut does the work):
  //       generic  = 0.6 x 0.9361 = 0.5617  <  minScore 0.6  → FLOORED, never ranked in.
  //       topical A = ln(63) x (1 + 0.6) = 4.1431 x 1.6 = 6.629 (key @ depth 0 + alias @ depth 1) ← top
  //       topical B = 0.72 x 4.1431 = 2.983, vs relCut floor 0.35 x 6.629 = 2.320 → fires.
  {
    name: 'generic-key-guardian',
    category: 'generickey',
    books: [
      book('Thistledown', [
        E({ keys: ['Thistledown Reliquary', 'the reliquary seal'], content: 'A cedar box that has not been opened in living memory.', comment: 'Reliquary-TOPICAL' }),
        E({ keys: ['Vesper Lantern-house', 'the vesper lamps'], content: 'A stone tower lit from dusk until the third bell.', comment: 'Lanternhouse-TOPICAL' }),
        ...Array.from({ length: 10 }, (_, i) =>
          E({
            keys: ['guardian', `Wardsman ${i}`],
            // Body omits the shared key so these ten do not donate one-hop bonuses to each other. df is
            // unaffected: an entry that DECLARES k counts toward df(k) whether or not its body repeats it.
            content: `Post ${i}: a watch of the inner walk, relieved at every bell.`,
            comment: `Guardian-HN-${i}`
          })
        ),
        ...Array.from({ length: 30 }, (_, i) =>
          E({
            keys: [`Thistle Note ${i}`],
            content: `Note ${i}: the guardian custom, observed here as everywhere.`,
            comment: `Thistledown-guardian-filler-${i}`,
            insertion_order: 500 + i
          })
        ),
        ...Array.from({ length: 20 }, (_, i) =>
          E({
            keys: [`Downland Note ${i}`],
            content: `Note ${i}: a plain entry with nothing remarkable in it.`,
            comment: `Thistledown-plain-filler-${i}`,
            insertion_order: 600 + i
          })
        )
      ])
    ],
    segments: [
      // ~48 chars.
      seg(0, 'I lift the Thistledown Reliquary off its shelf.'),
      seg(
        1,
        'The reliquary seal was checked at dusk, as it is every night, by whichever guardian has drawn the inner walk — and tonight that is a boy of about seventeen who has clearly been told what to look for and equally clearly does not know why. He signs the slate, rings the bell once, and goes back out into the cold. Nobody has ever found the seal broken. Nobody expects to. The custom survives because breaking it would require somebody to decide, out loud and in front of witnesses, that it was pointless, and no one in this house has ever wanted to be the person who did that.'
      ),
      seg(
        2,
        'Two nights ago the Vesper Lantern-house burned oil until nearly dawn, which it is not supposed to do, and the vesper lamps were still lit when the carters came through at first light. The keeper claims a fault in the regulator and has produced a plausible-looking part to prove it. The steward does not believe him and has said so, and the two of them have settled into the kind of slow, courteous, entirely irreconcilable dispute that can go on for years in a house this size. The lamps, meanwhile, are burning on the old schedule again and nobody has explained how that was achieved.'
      )
    ],
    pinText: '',
    relevant: [ref('Thistledown', 0), ref('Thistledown', 1)],
    hardNegative: Array.from({ length: 10 }, (_, i) => ref('Thistledown', 2 + i))
  }
]

/** The 2026-07-24 additions: the broad-evidence / persistence pair plus the four structural families. */
export const NEW_SCENARIOS: Scenario[] = [...PERSIST_BROAD_SCENARIOS, ...STRUCTURAL_SCENARIOS]

/** The full evaluation suite: original tuned scenarios + the new broad-evidence / persistence ones. */
export const SCENARIOS: Scenario[] = [...ORIGINAL_SCENARIOS, ...NEW_SCENARIOS]

/** Look up a scenario by name (throws if absent — keeps the regression test honest). */
export const scenario = (name: string): Scenario => {
  const s = SCENARIOS.find((x) => x.name === name)
  if (!s) throw new Error(`unknown scenario: ${name}`)
  return s
}
