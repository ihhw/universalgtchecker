/**
 * Word pools for the Discord generator's word-based modes.
 * All stored in lowercase to match Discord's username convention.
 */

const SHORT_WORD_BLOB =
  "acidaeroagedallyapexarchariaatomauraaxisbanebeambetabiteblipblurboltbrimbyte" +
  "calmcavecharclawcodecoldcorecosycrowdawndazedeckdripduskechoedgeepicfangfern" +
  "fluxfoamgaleglowgridgrimhalohazehushirisjadejoltkilokitelarklavalimelinkluna" +
  "lynxmacemintmistmusemythnavyneonnovaonyxopalpalepeakplumrainriftsagesilksnow" +
  "solostarstemtidevoidwavewispwolfxenoyarnyetizealzerozinczonearilbuhrcymafane" +
  "ilexixiajapekelpkithlinnrimewoadyarefardfoudhylekamemiltuveafirn";
export const SHORT_WORDS: readonly string[] = chunk(SHORT_WORD_BLOB, 4);

const RARE_WORD_BLOB =
  "amberazureemberfablefrostorbitpixelpulsequillslatesparkabysmadretaegisaglet" +
  "alateamiceanileapianarborardorargotaskewattarauricazothbardobezelbightbohea" +
  "boricbrumecairncalyxchertchirkcivetcladeclarycoigndightdongadrossducaleagree" +
  "clateduceelideenvoiergotetweefetorfirthflumefrondgamicgaultghyllglebeglume" +
  "goralgrithguyothalerhelvehilumhouriicticinurnjabotjorumkedgeknurllaitylathyl" +
  "emanlumenmaclemaundmerlemurexnacrenivalnonceockerogiveorlopoxterpavidpewit" +
  "pingoplicaprillquernquoinratalroblesakersalepscurfsepalshawmsilexsizarskirl" +
  "soughstoupswaletargetigontopertronaulemaumbelurialvaticvelarvireowhealwight" +
  "xeniczayinzebeczonda";
export const RARE_WORDS: readonly string[] = chunk(RARE_WORD_BLOB, 5);

const OBSCURE_WORD_BLOB =
  "abditablowaboonabsitacmicaduncaegiraiveralbeealephalgidalureambitamoleanelean" +
  "entannalanomyarameargalarlesaroidasconascusaulicavensavisoaxileazidebairnbalky" +
  "bardebaricbassibattubawtybeanobedelbeedibemixbermebirleblateblawnblentblore" +
  "boartbocceboffobolarbonceboralbortyboskybractbramebromebunducadgecairdcalky" +
  "camuscavieceorlceredchapechirmchirtchylecimarclepeclourcoblecogoncoombcozen" +
  "crakecreelcronkcruseculchculetcusecdavitdeavedeedydemitdizendobladoorndoura" +
  "dowiedrantdreckdunamealedephoretapeettlefanalfaughfeuarflaryfleamfliskflong" +
  "flotaforbyfrapefrithfuglegallyganevgawkygibusgimelgiponglairgleetgliskgopak" +
  "gricegromagrykegurshhainthamalhaughhaverhelothormehoughinklejagerjambujiber" +
  "juralkabobkaiakkalamkepiskirbykvasslairdlanailarumlaverleachlearylimenlorel" +
  "lurrymaficmalicmargemashymesicmoraemowramucidmungonairunaresnievenogalnooky" +
  "oaredoctadodyleollavopineorpinottarpangapannepareupavispeerypeisepiculpisky" +
  "pleonpraamproemquirtrabatraneerenterhemerhyneriantronderubleruchesabalsagum" +
  "samelscaupsegarselahsengiseracshielsmazesnecksnoodsorelspeansteddstirksward" +
  "tabortawietentythirltichytorsktrullulnarunlayvarecvenalvinalvolarwackewaled" +
  "wealdwiddywirrawurstxylanyamenyapokyestyzabrazibetzillszoril";
export const OBSCURE_WORDS: readonly string[] = chunk(OBSCURE_WORD_BLOB, 5);

const POOL_A = (
  "north south east west upper lower inner outer red blue black white green gold " +
  "silver pink purple orange gray grey brown cyan teal navy lime mint coral ruby " +
  "jade pearl ivory onyx amber cherry copper bronze indigo violet dawn dusk morning " +
  "evening night day noon midnight sunrise sunset twilight summer winter spring autumn " +
  "wild calm cool warm cold hot fresh old new young sharp smooth rough soft hard " +
  "quick slow fast bright dark dull clear foggy cloudy sunny stormy quiet loud silent " +
  "roaring sky sea ocean coast river lake forest wood tree leaf stone rock sand snow " +
  "rain wind storm cloud sun moon star fire water ice earth mountain hill valley canyon " +
  "desert cliff cave spring tide wave thunder lightning breeze mist frost hail drizzle " +
  "flood drought blizzard tornado hurricane monsoon cyclone peace joy love hope dream " +
  "fear brave kind pride rage fury soul spirit ghost mercy grace honor glory faith trust " +
  "truth memory secret whisper promise fate destiny karma fall rise run walk jump fly " +
  "swim dive climb break crack burn glow shine spark hit kick punch slash cut chop slice " +
  "dash sprint chase hunt seek find keep lose sword shield crown ring gem coin book key " +
  "lock door gate wall tower bridge road path trail camp tent hut house home castle " +
  "throne spear bow arrow axe hammer dagger blade helm armor cloak robe mask glove boot " +
  "belt wolf fox bear lion tiger eagle hawk crow raven owl snake shark whale deer elk " +
  "moose hare rabbit mouse cat dog lynx panther leopard jaguar puma boar stag"
).split(" ");

const POOL_B = (
  "town city village hamlet fort keep manor hall temple shrine church market port " +
  "harbor dock bay cove inlet isle head hand foot arm leg eye ear nose mouth tooth " +
  "claw fang wing tail horn steel iron brass copper glass cloth silk wool leather " +
  "paper clay one two three four five six seven eight nine ten comet meteor planet " +
  "orbit galaxy nebula cosmos ether void abyss zenith horizon aurora eclipse solstice " +
  "rifle pistol cannon mortar mine bomb grenade missile rocket sniper scope trigger " +
  "bullet shell song tune beat rhythm chord melody anthem hymn chorus verse pixel " +
  "byte code chip data cyber crypto laser radar signal circuit matrix nexus vector " +
  "blaze ash smoke dust mud thorn ivy moss fern reed vine root bark branch seed " +
  "flower petal bloom berry fruit apple grape lemon peach plum pear bite drink eat " +
  "sleep wake sing dance play laugh cry shout yell scream talk speak listen hear see " +
  "look watch search explore wander happy sad angry tired hungry thirsty sleepy awake " +
  "alive dead real fake true false good bad evil holy clean dirty rich poor wise"
).split(" ");

const POOL_C = (
  "shadow phantom specter wraith banshee revenant sorrow bliss chaos infinite " +
  "infinity eternity forever always never mystic magical sacred holy divine cursed " +
  "blessed gaming gamer player gamemaster gameover epic legend legendary mythical " +
  "mythic mythos alpha beta gamma delta omega sigma theta lambda victory triumph " +
  "defeat glory shame puzzle riddle mystery enigma cipher wanderlust adventure " +
  "quest voyage expedition harmony melody tempo tune silence echo murmur hum buzz " +
  "phoenix dragon unicorn griffin pegasus sphinx cyberpunk neon chrome vapor synth " +
  "retro future cosmic starlight moonlight twilight hunter tracker ranger scout " +
  "explorer pioneer warrior fighter boxer wrestler samurai ninja shinobi sailor " +
  "pirate captain admiral commander general knight paladin templar crusader guardian " +
  "warden wizard mage sorcerer warlock enchanter conjurer bard minstrel troubadour " +
  "poet artist painter monk priest cleric bishop cardinal pope king queen prince " +
  "princess royal noble emperor empress smith mason weaver tanner tailor baker " +
  "butcher doctor healer medic physician surgeon nurse teacher scholar student pupil " +
  "master apprentice thief rogue bandit outlaw smuggler spy agent assassin marksman " +
  "scout spirit soul essence being entity presence velocity momentum gravity inertia " +
  "entropy cosmos void zenith abyss eternity infinity"
).split(" ");

function chunk(blob: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < blob.length; i += size) out.push(blob.slice(i, i + size));
  return out;
}

/** Deduplicated, in first-seen order. */
function dedupe(words: string[]): string[] {
  return [...new Set(words)];
}

/** Short (4-char), rare (5-char) and obscure (5-char) word fragments — dense, high-yield. */
export const FRAGMENT_WORDS: readonly string[] = dedupe([...SHORT_WORDS, ...RARE_WORDS, ...OBSCURE_WORDS]);

/** Real dictionary-style words — themes, colors, animals, fantasy/gaming terms. */
export const DICTIONARY_WORDS: readonly string[] = dedupe([...POOL_A, ...POOL_B, ...POOL_C]);

/** Everything combined, for the highest-yield pairing modes. */
export const ALL_WORDS: readonly string[] = dedupe([...FRAGMENT_WORDS, ...DICTIONARY_WORDS]);
