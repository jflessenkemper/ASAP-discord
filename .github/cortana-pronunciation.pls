<?xml version="1.0" encoding="UTF-8"?>
<!--
  Cortana pronunciation dictionary for ElevenLabs.

  Upload in the Conversational AI agent's Voice settings → Pronunciation dictionary,
  or attach to the voice directly under Voices → <voice> → Pronunciation dictionaries.

  Scope:
    1. Tech + product terms Cortana will say while helping Jordan (Anthropic, ASAP, APIs, etc.)
    2. Common acronyms Cortana should spell out vs read as words
    3. Agent name pronunciations (the Greek pantheon + Cortana herself)
    4. Halo-universe lore terms — sourced from Bungie forum posts, Halopedia, and the
       Sangheili language page. Pronunciations match how Jen Taylor renders them in-game.
    5. Military jargon Cortana uses casually
    6. British colloquialisms she keeps even without the accent
    7. Dry / measured enunciations that bias her toward her signature cadence

  Format:
    <alias>    — simple text substitution (easiest; no phonetics)
    <phoneme>  — IPA (precise; use for names aliases can't capture)

  To extend: add more <lexeme> blocks below. The lexicon is case-insensitive.
-->
<lexicon version="1.0"
  xmlns="http://www.w3.org/2005/01/pronunciation-lexicon"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.w3.org/2005/01/pronunciation-lexicon
    http://www.w3.org/TR/2007/CR-pronunciation-lexicon-20071212/pls.xsd"
  alphabet="ipa" xml:lang="en-US">

  <!-- ════════════════════════════════════════════════════════════════════
       1. PRODUCT + TECH PROPER NOUNS
  ════════════════════════════════════════════════════════════════════ -->

  <lexeme><grapheme>ASAP</grapheme><alias>ay-sap</alias></lexeme>
  <lexeme><grapheme>Anthropic</grapheme><phoneme>ænˈθɹɒpɪk</phoneme></lexeme>
  <lexeme><grapheme>Claude</grapheme><phoneme>klɔːd</phoneme></lexeme>
  <lexeme><grapheme>ElevenLabs</grapheme><alias>eleven labs</alias></lexeme>
  <lexeme><grapheme>Gemini</grapheme><phoneme>ˈdʒɛmɪnaɪ</phoneme></lexeme>
  <lexeme><grapheme>GitHub</grapheme><alias>git hub</alias></lexeme>
  <lexeme><grapheme>nginx</grapheme><alias>engine x</alias></lexeme>
  <lexeme><grapheme>Kubernetes</grapheme><alias>koo-burr-NET-eez</alias></lexeme>
  <lexeme><grapheme>PostgreSQL</grapheme><alias>post gress queue el</alias></lexeme>
  <lexeme><grapheme>TypeScript</grapheme><alias>type script</alias></lexeme>
  <lexeme><grapheme>JavaScript</grapheme><alias>java script</alias></lexeme>
  <lexeme><grapheme>Vertex</grapheme><phoneme>ˈvɜːɹtɛks</phoneme></lexeme>
  <lexeme><grapheme>OAuth</grapheme><alias>oh auth</alias></lexeme>
  <lexeme><grapheme>webhook</grapheme><alias>web hook</alias></lexeme>
  <lexeme><grapheme>webhooks</grapheme><alias>web hooks</alias></lexeme>
  <lexeme><grapheme>pgvector</grapheme><alias>pee gee vector</alias></lexeme>
  <lexeme><grapheme>Redis</grapheme><phoneme>ˈɹɛdɪs</phoneme></lexeme>
  <lexeme><grapheme>Docker</grapheme><phoneme>ˈdɒkɚ</phoneme></lexeme>

  <!-- ════════════════════════════════════════════════════════════════════
       2. ACRONYMS — SPELL-OUT RULES
  ════════════════════════════════════════════════════════════════════ -->

  <lexeme><grapheme>API</grapheme><alias>ay pee eye</alias></lexeme>
  <lexeme><grapheme>CLI</grapheme><alias>see ell eye</alias></lexeme>
  <lexeme><grapheme>SQL</grapheme><alias>sequel</alias></lexeme>
  <lexeme><grapheme>CI/CD</grapheme><alias>see eye see dee</alias></lexeme>
  <lexeme><grapheme>GCP</grapheme><alias>gee see pee</alias></lexeme>
  <lexeme><grapheme>GPU</grapheme><alias>gee pee you</alias></lexeme>
  <lexeme><grapheme>CPU</grapheme><alias>see pee you</alias></lexeme>
  <lexeme><grapheme>LLM</grapheme><alias>ell ell em</alias></lexeme>
  <lexeme><grapheme>TTS</grapheme><alias>tee tee ess</alias></lexeme>
  <lexeme><grapheme>STT</grapheme><alias>ess tee tee</alias></lexeme>
  <lexeme><grapheme>k8s</grapheme><alias>kates</alias></lexeme>
  <lexeme><grapheme>SDK</grapheme><alias>ess dee kay</alias></lexeme>
  <lexeme><grapheme>IDE</grapheme><alias>eye dee ee</alias></lexeme>
  <lexeme><grapheme>JSON</grapheme><alias>jay-son</alias></lexeme>
  <lexeme><grapheme>YAML</grapheme><alias>yammel</alias></lexeme>
  <lexeme><grapheme>TOML</grapheme><alias>tommel</alias></lexeme>
  <lexeme><grapheme>HTTP</grapheme><alias>aych tee tee pee</alias></lexeme>
  <lexeme><grapheme>HTTPS</grapheme><alias>aych tee tee pee ess</alias></lexeme>
  <lexeme><grapheme>PR</grapheme><alias>pee arr</alias></lexeme>
  <lexeme><grapheme>DM</grapheme><alias>dee em</alias></lexeme>
  <lexeme><grapheme>UI</grapheme><alias>you eye</alias></lexeme>
  <lexeme><grapheme>UX</grapheme><alias>you ex</alias></lexeme>
  <lexeme><grapheme>QA</grapheme><alias>cue ay</alias></lexeme>
  <lexeme><grapheme>AI</grapheme><alias>ay eye</alias></lexeme>
  <lexeme><grapheme>RAG</grapheme><alias>rag</alias></lexeme>
  <lexeme><grapheme>IAM</grapheme><alias>eye ay em</alias></lexeme>
  <lexeme><grapheme>SRE</grapheme><alias>ess arr ee</alias></lexeme>

  <!-- ════════════════════════════════════════════════════════════════════
       3. OWNER + AGENT PANTHEON NAMES
  ════════════════════════════════════════════════════════════════════ -->

  <lexeme><grapheme>Jordan</grapheme><phoneme>ˈdʒɔːɹdən</phoneme></lexeme>
  <lexeme><grapheme>Flessenkemper</grapheme><alias>FLESS-en-KEMP-er</alias></lexeme>

  <!-- Cortana herself — soft T, clear A, as Jen Taylor says it -->
  <lexeme><grapheme>Cortana</grapheme><phoneme>kɔːɹˈtɑːnə</phoneme></lexeme>

  <!-- Greek pantheon specialists -->
  <lexeme><grapheme>Argus</grapheme><phoneme>ˈɑːɹɡəs</phoneme></lexeme>
  <lexeme><grapheme>Aphrodite</grapheme><phoneme>ˌæfɹəˈdaɪti</phoneme></lexeme>
  <lexeme><grapheme>Athena</grapheme><phoneme>əˈθiːnə</phoneme></lexeme>
  <lexeme><grapheme>Iris</grapheme><phoneme>ˈaɪɹɪs</phoneme></lexeme>
  <lexeme><grapheme>Mnemosyne</grapheme><phoneme>nɪˈmɒzɪni</phoneme></lexeme>
  <lexeme><grapheme>Hermes</grapheme><phoneme>ˈhɜːɹmiːz</phoneme></lexeme>
  <lexeme><grapheme>Hephaestus</grapheme><phoneme>hɪˈfɛstəs</phoneme></lexeme>
  <lexeme><grapheme>Calliope</grapheme><phoneme>kəˈlaɪəpi</phoneme></lexeme>
  <lexeme><grapheme>Themis</grapheme><phoneme>ˈθiːmɪs</phoneme></lexeme>
  <lexeme><grapheme>Artemis</grapheme><phoneme>ˈɑːɹtəmɪs</phoneme></lexeme>
  <lexeme><grapheme>Prometheus</grapheme><phoneme>pɹəˈmiːθiəs</phoneme></lexeme>

  <!-- ════════════════════════════════════════════════════════════════════
       4. HALO LORE — FACTIONS, SPECIES, SHIPS, PLACES, CHARACTERS

       Pronunciations sourced from Bungie forum official threads and
       Halopedia's Sangheili language page. Where sources disagreed,
       favored the pronunciation Jen Taylor uses in-game.
  ════════════════════════════════════════════════════════════════════ -->

  <!-- Core terms -->
  <lexeme><grapheme>Halo</grapheme><phoneme>ˈheɪloʊ</phoneme></lexeme>
  <lexeme><grapheme>Covenant</grapheme><phoneme>ˈkʌvənənt</phoneme></lexeme>
  <lexeme><grapheme>Forerunner</grapheme><alias>FORE-runner</alias></lexeme>
  <lexeme><grapheme>Forerunners</grapheme><alias>FORE-runners</alias></lexeme>
  <lexeme><grapheme>Flood</grapheme><phoneme>flʌd</phoneme></lexeme>
  <lexeme><grapheme>Gravemind</grapheme><alias>grave mind</alias></lexeme>
  <lexeme><grapheme>Chief</grapheme><phoneme>tʃiːf</phoneme></lexeme>
  <lexeme><grapheme>Spartan</grapheme><phoneme>ˈspɑːɹtən</phoneme></lexeme>
  <lexeme><grapheme>Spartans</grapheme><phoneme>ˈspɑːɹtənz</phoneme></lexeme>
  <lexeme><grapheme>Mjolnir</grapheme><alias>MEE-oll-neer</alias></lexeme>

  <!-- Covenant species — canonical pronunciations -->
  <lexeme><grapheme>Sangheili</grapheme><alias>sang-HAY-lee</alias></lexeme>
  <lexeme><grapheme>Unggoy</grapheme><alias>OON-goy</alias></lexeme>
  <lexeme><grapheme>Kig-Yar</grapheme><alias>KIG-yar</alias></lexeme>
  <lexeme><grapheme>Jiralhanae</grapheme><alias>jih-RULL-uh-nay</alias></lexeme>
  <lexeme><grapheme>Lekgolo</grapheme><alias>leck-GOH-loh</alias></lexeme>
  <lexeme><grapheme>Huragok</grapheme><alias>HOO-ruh-gok</alias></lexeme>
  <lexeme><grapheme>Yanme'e</grapheme><alias>yan-MAY-ee</alias></lexeme>
  <lexeme><grapheme>San'Shyuum</grapheme><alias>san-SHY-oom</alias></lexeme>

  <!-- Covenant plain names -->
  <lexeme><grapheme>Elites</grapheme><phoneme>ɪˈliːts</phoneme></lexeme>
  <lexeme><grapheme>Grunts</grapheme><phoneme>ɡɹʌnts</phoneme></lexeme>
  <lexeme><grapheme>Jackals</grapheme><phoneme>ˈdʒækəlz</phoneme></lexeme>
  <lexeme><grapheme>Brutes</grapheme><phoneme>bɹuːts</phoneme></lexeme>
  <lexeme><grapheme>Hunters</grapheme><phoneme>ˈhʌntɚz</phoneme></lexeme>
  <lexeme><grapheme>Prophets</grapheme><phoneme>ˈpɹɒfɪts</phoneme></lexeme>
  <lexeme><grapheme>Engineers</grapheme><phoneme>ˌɛndʒɪˈnɪɹz</phoneme></lexeme>
  <lexeme><grapheme>Drones</grapheme><phoneme>dɹoʊnz</phoneme></lexeme>
  <lexeme><grapheme>Arbiter</grapheme><phoneme>ˈɑːɹbɪtɚ</phoneme></lexeme>

  <!-- UNSC orgs + ranks -->
  <lexeme><grapheme>UNSC</grapheme><alias>you en ess see</alias></lexeme>
  <lexeme><grapheme>ONI</grapheme><alias>OH-nee</alias></lexeme>
  <lexeme><grapheme>ODST</grapheme><alias>oh dee ess tee</alias></lexeme>
  <lexeme><grapheme>MAC</grapheme><alias>mack</alias></lexeme>
  <lexeme><grapheme>HEV</grapheme><alias>aych ee vee</alias></lexeme>

  <!-- Ships -->
  <lexeme><grapheme>Pillar of Autumn</grapheme><alias>pillar of AW-tum</alias></lexeme>
  <lexeme><grapheme>In Amber Clad</grapheme><alias>in amber clad</alias></lexeme>
  <lexeme><grapheme>Forward Unto Dawn</grapheme><alias>forward un-too dawn</alias></lexeme>
  <lexeme><grapheme>Infinity</grapheme><phoneme>ɪnˈfɪnɪti</phoneme></lexeme>
  <lexeme><grapheme>Spirit of Fire</grapheme><alias>spirit of fire</alias></lexeme>
  <lexeme><grapheme>Pelican</grapheme><phoneme>ˈpɛlɪkən</phoneme></lexeme>
  <lexeme><grapheme>Longsword</grapheme><alias>long sword</alias></lexeme>
  <lexeme><grapheme>Banshee</grapheme><phoneme>ˈbænʃiː</phoneme></lexeme>
  <lexeme><grapheme>Phantom</grapheme><phoneme>ˈfæntəm</phoneme></lexeme>
  <lexeme><grapheme>Seraph</grapheme><phoneme>ˈsɛɹəf</phoneme></lexeme>

  <!-- Vehicles -->
  <lexeme><grapheme>Warthog</grapheme><alias>wart hog</alias></lexeme>
  <lexeme><grapheme>Scorpion</grapheme><phoneme>ˈskɔːɹpiən</phoneme></lexeme>
  <lexeme><grapheme>Mongoose</grapheme><phoneme>ˈmɒŋɡuːs</phoneme></lexeme>
  <lexeme><grapheme>Wolverine</grapheme><alias>WUL-ver-een</alias></lexeme>
  <lexeme><grapheme>Wraith</grapheme><phoneme>ɹeɪθ</phoneme></lexeme>
  <lexeme><grapheme>Ghost</grapheme><phoneme>ɡoʊst</phoneme></lexeme>

  <!-- Places -->
  <lexeme><grapheme>Reach</grapheme><phoneme>ɹiːtʃ</phoneme></lexeme>
  <lexeme><grapheme>High Charity</grapheme><alias>high CHAR-ity</alias></lexeme>
  <lexeme><grapheme>New Mombasa</grapheme><alias>new mom-BAH-sah</alias></lexeme>
  <lexeme><grapheme>Voi</grapheme><alias>voy</alias></lexeme>
  <lexeme><grapheme>Requiem</grapheme><alias>REK-wee-em</alias></lexeme>
  <lexeme><grapheme>Installation 04</grapheme><alias>installation zero four</alias></lexeme>
  <lexeme><grapheme>Installation 05</grapheme><alias>installation zero five</alias></lexeme>
  <lexeme><grapheme>Zeta Halo</grapheme><alias>ZAY-tuh HAY-loh</alias></lexeme>
  <lexeme><grapheme>Harvest</grapheme><phoneme>ˈhɑːɹvɪst</phoneme></lexeme>
  <lexeme><grapheme>the Ark</grapheme><alias>the ark</alias></lexeme>

  <!-- Key characters -->
  <lexeme><grapheme>Halsey</grapheme><alias>HALL-see</alias></lexeme>
  <lexeme><grapheme>Keyes</grapheme><alias>keez</alias></lexeme>
  <lexeme><grapheme>Johnson</grapheme><phoneme>ˈdʒɒnsən</phoneme></lexeme>
  <lexeme><grapheme>Locke</grapheme><phoneme>lɒk</phoneme></lexeme>
  <lexeme><grapheme>Didact</grapheme><alias>DYE-dact</alias></lexeme>
  <lexeme><grapheme>Librarian</grapheme><alias>lie-BRAIR-ian</alias></lexeme>
  <lexeme><grapheme>Thel 'Vadam</grapheme><alias>THEL va-DAHM</alias></lexeme>
  <lexeme><grapheme>'Vadam</grapheme><alias>va-DAHM</alias></lexeme>
  <lexeme><grapheme>'Vadamee</grapheme><alias>va-DAH-mee</alias></lexeme>

  <!-- Tech + concepts -->
  <lexeme><grapheme>slipspace</grapheme><alias>slip space</alias></lexeme>
  <lexeme><grapheme>Cole Protocol</grapheme><alias>cole protocol</alias></lexeme>
  <lexeme><grapheme>Prometheans</grapheme><phoneme>pɹəˈmiːθiənz</phoneme></lexeme>
  <lexeme><grapheme>Composer</grapheme><phoneme>kəmˈpoʊzɚ</phoneme></lexeme>
  <lexeme><grapheme>Monitor</grapheme><phoneme>ˈmɒnɪtɚ</phoneme></lexeme>
  <lexeme><grapheme>343 Guilty Spark</grapheme><alias>three forty three guilty spark</alias></lexeme>
  <lexeme><grapheme>Index</grapheme><phoneme>ˈɪndɛks</phoneme></lexeme>

  <!-- ════════════════════════════════════════════════════════════════════
       5. MILITARY JARGON — Cortana's register
  ════════════════════════════════════════════════════════════════════ -->

  <lexeme><grapheme>klicks</grapheme><alias>clicks</alias></lexeme>
  <lexeme><grapheme>klick</grapheme><alias>click</alias></lexeme>
  <lexeme><grapheme>comms</grapheme><alias>coms</alias></lexeme>
  <lexeme><grapheme>sitrep</grapheme><alias>sit rep</alias></lexeme>
  <lexeme><grapheme>nav</grapheme><alias>nav</alias></lexeme>
  <lexeme><grapheme>ETA</grapheme><alias>ee tee ay</alias></lexeme>
  <lexeme><grapheme>FOB</grapheme><alias>fob</alias></lexeme>
  <lexeme><grapheme>wilco</grapheme><alias>will co</alias></lexeme>
  <lexeme><grapheme>oscar mike</grapheme><alias>OSS-car MIKE</alias></lexeme>
  <lexeme><grapheme>tango</grapheme><alias>TANG-go</alias></lexeme>
  <lexeme><grapheme>bogey</grapheme><alias>BO-gee</alias></lexeme>
  <lexeme><grapheme>AO</grapheme><alias>ay oh</alias></lexeme>
  <lexeme><grapheme>DZ</grapheme><alias>dee zee</alias></lexeme>
  <lexeme><grapheme>LZ</grapheme><alias>ell zee</alias></lexeme>
  <lexeme><grapheme>intel</grapheme><phoneme>ˈɪntɛl</phoneme></lexeme>
  <lexeme><grapheme>recon</grapheme><alias>REE-kon</alias></lexeme>
  <lexeme><grapheme>IFF</grapheme><alias>eye eff eff</alias></lexeme>
  <lexeme><grapheme>mic</grapheme><phoneme>maɪk</phoneme></lexeme>
  <lexeme><grapheme>mics</grapheme><phoneme>maɪks</phoneme></lexeme>
  <lexeme><grapheme>Roger that</grapheme><alias>ROE-jer that</alias></lexeme>
  <lexeme><grapheme>Copy that</grapheme><alias>COP-y that</alias></lexeme>

  <!-- ════════════════════════════════════════════════════════════════════
       6. BRITISH COLLOQUIALISMS CORTANA KEEPS

       Jen Taylor dropped the British accent but kept British vocabulary.
       These aliases nudge American TTS toward the British enunciation
       when the word could sound flat otherwise.
  ════════════════════════════════════════════════════════════════════ -->

  <lexeme><grapheme>bloody</grapheme><alias>BLUH-dee</alias></lexeme>
  <lexeme><grapheme>brilliant</grapheme><alias>BRILL-yent</alias></lexeme>
  <lexeme><grapheme>bastards</grapheme><alias>BAH-stards</alias></lexeme>
  <lexeme><grapheme>bastard</grapheme><alias>BAH-stard</alias></lexeme>
  <lexeme><grapheme>sod off</grapheme><alias>SOD off</alias></lexeme>
  <lexeme><grapheme>cheers</grapheme><phoneme>tʃɪɹz</phoneme></lexeme>
  <lexeme><grapheme>toady</grapheme><alias>TOH-dee</alias></lexeme>

  <!-- ════════════════════════════════════════════════════════════════════
       7. NUMBERS + CALLSIGN-STYLE READINGS

       Cortana reads serial numbers and coordinates as individual digits.
       These aliases nudge the TTS toward that style when she emits short
       number strings. Longer numbers (years, dollar amounts) are unaffected.
  ════════════════════════════════════════════════════════════════════ -->

  <lexeme><grapheme>0-0-0</grapheme><alias>zero zero zero</alias></lexeme>
  <lexeme><grapheme>John-117</grapheme><alias>john one one seven</alias></lexeme>
  <lexeme><grapheme>Spartan-117</grapheme><alias>spartan one one seven</alias></lexeme>
  <lexeme><grapheme>Spartan-II</grapheme><alias>spartan two</alias></lexeme>
  <lexeme><grapheme>Spartan-III</grapheme><alias>spartan three</alias></lexeme>
  <lexeme><grapheme>Spartan-IV</grapheme><alias>spartan four</alias></lexeme>

</lexicon>
