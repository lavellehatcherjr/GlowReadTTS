// libs/kokoro/voices-catalog.js
// Single source of truth for shipped Kokoro voices.
// Quality grades sourced from https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
// Editorial standard: ship voices graded C or above by the model author.
// English-only for v1. Multilingual support deferred until kokoro-js bundles non-English G2P.

export const LANGUAGES = [
  { code: 'a', name: 'American English', flag: '🇺🇸' },
  { code: 'b', name: 'British English', flag: '🇬🇧' }
];

export const VOICES = [
  // American English, ordered by grade descending
  { id: 'af_heart',   lang: 'a', gender: 'f', displayName: 'Heart',   tagline: 'Warm and natural',    grade: 'A'  },
  { id: 'af_bella',   lang: 'a', gender: 'f', displayName: 'Bella',   tagline: 'Clear and friendly',  grade: 'A-' },
  { id: 'af_nicole',  lang: 'a', gender: 'f', displayName: 'Nicole',  tagline: 'Smooth and calm',     grade: 'B-' },
  { id: 'af_aoede',   lang: 'a', gender: 'f', displayName: 'Aoede',   tagline: 'Bright and clear',    grade: 'C+' },
  { id: 'af_kore',    lang: 'a', gender: 'f', displayName: 'Kore',    tagline: 'Gentle and steady',   grade: 'C+' },
  { id: 'af_sarah',   lang: 'a', gender: 'f', displayName: 'Sarah',   tagline: 'Friendly narrator',   grade: 'C+' },
  { id: 'am_fenrir',  lang: 'a', gender: 'm', displayName: 'Fenrir',  tagline: 'Strong and grounded', grade: 'C+' },
  { id: 'am_michael', lang: 'a', gender: 'm', displayName: 'Michael', tagline: 'Professional',        grade: 'C+' },
  { id: 'am_puck',    lang: 'a', gender: 'm', displayName: 'Puck',    tagline: 'Light and quick',     grade: 'C+' },
  { id: 'af_alloy',   lang: 'a', gender: 'f', displayName: 'Alloy',   tagline: 'Balanced',            grade: 'C'  },
  { id: 'af_nova',    lang: 'a', gender: 'f', displayName: 'Nova',    tagline: 'Bright and youthful', grade: 'C'  },
  // British English, ordered by grade descending
  { id: 'bf_emma',     lang: 'b', gender: 'f', displayName: 'Emma',     tagline: 'Warm British',     grade: 'B-' },
  { id: 'bf_isabella', lang: 'b', gender: 'f', displayName: 'Isabella', tagline: 'Refined British',  grade: 'C'  },
  { id: 'bm_fable',    lang: 'b', gender: 'm', displayName: 'Fable',    tagline: 'Storyteller',      grade: 'C'  },
  { id: 'bm_george',   lang: 'b', gender: 'm', displayName: 'George',   tagline: 'Clear British',    grade: 'C'  }
];

export function voicesByLanguage(langCode) {
  return VOICES.filter(v => v.lang === langCode);
}

export function isValidVoiceId(voiceId) {
  return VOICES.some(v => v.id === voiceId);
}
