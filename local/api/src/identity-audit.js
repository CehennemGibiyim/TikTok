/*
 * identity-audit.js — kanonik kutu kimliği denetimi.
 *
 * İki üretim hatasını görünür kılar:
 *
 * 1. `key_collision`: iki farklı kutu aynı kanonik anahtara düşüyor. Aynı
 *    kayıt kimliğiyle farklı yayıncı, tür, oda veya açılış zamanı gelirse
 *    satır birleşir ve biri diğerinin üzerine yazar. Jeton/kontenjan farkı
 *    çakışma sayılmaz; bu, beklenen değer güncellemesidir.
 *
 * 2. `split_rows`: aynı kutu iki farklı kimlikle geldi. Yayıncı + oda + tür
 *    aynı, açılış zamanı da küçük bir tolerans içinde (±varsayılan 5 sn)
 *    aynıysa kimlikler bölünmüş demektir. Depo bunu yazma anında tek satırda
 *    birleştirir; sayaç yine de kanıt üretir (eski satırlar ve eşzamanlı
 *    yarışlarda satır gerçekten iki tane kalabilir). Kaynaklar aynı kutuyu
 *    birkaç saniye farklı bildirebiliyor; tolerans örnek kaydında
 *    `timeDeltaMs` ve `toleranceMs` olarak görünür.
 *
 * Sayaçlar süreç içidir (yeniden başlatmada sıfırlanır) ve yalnızca teşhis
 * amaçlıdır; hiçbir kaydı sessizce birleştirmez veya silmez. Örnekler ve
 * izlenen anahtarlar sınırlı tutulur (kimlik başına 20.000, içerik tabanı
 * başına 8 satır, 5 örnek), böylece üretimde bellek şişmez.
 */

import { CONTENT_TOLERANCE_MS, contentBase } from './box-identity.js';

const HARD_FIELDS = ['kind', 'creator', 'room_id', 'opens_at_ms'];
const DEFAULT_SAMPLE_LIMIT = 5;
const DEFAULT_MAX_TRACKED = 20000;
// Aynı içerik tabanında tolerans penceresinde tutulan satır kaydı. Teşhis
// için 8 yeterli; üst sınır maxTracked × 8 kayıttır.
const ENTRIES_PER_BASE = 8;

// Karşılaştırılacak tüm alanlar tek yerde normalize edilir; böylece eşitlik
// kontrolü alan bazlı özel kurallar gerektirmez.
function normalize(event) {
  return {
    kind: event.kind === 'bag' ? 'bag' : 'chest',
    creator: String(event.creator || '').trim().toLowerCase(),
    room_id: String(event.room_id || '').trim(),
    opens_at_ms: Number(event.opens_at_ms) || 0,
    total_coins: Number(event.total_coins) || 0,
    winner_count: Number(event.winner_count) || 0,
    source: String(event.source || '').slice(0, 20)
  };
}

export function createIdentityAudit({ sampleLimit, maxTracked, toleranceMs } = {}) {
  const limit = Math.max(1, Number(sampleLimit) || DEFAULT_SAMPLE_LIMIT);
  const trackedLimit = Math.max(10, Number(maxTracked) || DEFAULT_MAX_TRACKED);
  // 0 "tam eşleşme" demektir; eksik/geçersiz değerde varsayılan kullanılır.
  const requested = Number(toleranceMs);
  const tolerance = Number.isFinite(requested) && requested >= 0 ? requested : CONTENT_TOLERANCE_MS;

  const byKey = new Map();
  // Aynı içerik tabanındaki (oda + yayıncı + tür) son kutular. Liste küçük
  // tutulur; tolerans karşılaştırması için tarama yeterlidir.
  const byContent = new Map();
  const counters = { rows: 0, keyCollisions: 0, splitRows: 0 };
  let samples = [];

  function remember(map, key, value) {
    if (!map.has(key) && map.size >= trackedLimit) {
      // Map ekleme sırasını korur: en eski kaydı düşür.
      map.delete(map.keys().next().value);
    }
    map.set(key, value);
  }

  function addSample(key, sample) {
    if (samples.some((item) => item.key === key)) return;
    samples.push({ key, ...sample });
    if (samples.length > limit) samples = samples.slice(samples.length - limit);
  }

  function withinTolerance(entry, current) {
    return Math.abs(entry.opens_at_ms - current.opens_at_ms) <= tolerance;
  }

  // Çakışma yalnızca toleransın dışındaki kimlik farkıdır; kutu zaten
  // birleşirken birkaç saniyelik oynama beklenen durumdur.
  function changedField(field, known, current) {
    if (field === 'opens_at_ms') {
      return Math.abs(known.opens_at_ms - current.opens_at_ms) > tolerance;
    }
    return known[field] !== current[field];
  }

  /*
   * Yeni yazılan olayı denetler. Depoya yazma başarılı olduktan sonra
   * çağrılmalıdır; dönen bulgu (varsa) testlerde kullanılır.
   */
  function observe(event) {
    if (!event || !event.id) return null;
    const current = normalize(event);
    const id = String(event.id);
    counters.rows += 1;

    let finding = null;
    const known = byKey.get(id);

    if (known) {
      const changed = HARD_FIELDS.filter((field) => changedField(field, known, current));
      if (changed.length) {
        counters.keyCollisions += 1;
        finding = {
          type: 'key_collision',
          id,
          creator: current.creator,
          changed,
          before: known,
          after: current,
          detectedAt: Date.now()
        };
        addSample('key_collision|' + id, finding);
      }
    } else {
      remember(byKey, id, current);
    }

    // Zaman dışındaki içerik tabanı (oda + yayıncı + tür); depolar aynı
    // tanımı kullanır, burada yalnızca toleranslı karşılaştırma yapılır.
    const base = contentBase(current);
    if (base) {
      const entries = byContent.get(base) || [];
      const previous = entries.find((entry) => entry.id !== id && withinTolerance(entry, current));

      if (previous) {
        counters.splitRows += 1;
        const pair = [previous.id, id].sort();
        const split = {
          type: 'split_rows',
          ids: pair,
          sources: [previous.source, current.source],
          creator: current.creator,
          opens_at_ms: current.opens_at_ms,
          timeDeltaMs: current.opens_at_ms - previous.opens_at_ms,
          toleranceMs: tolerance,
          detectedAt: Date.now()
        };
        addSample('split_rows|' + pair.join('|'), split);
        finding = finding || split;
      } else if (!entries.some((entry) => entry.id === id)) {
        // İlk görülen açılış zamanı sabit kalır; güncellemeler pencereyi
        // kaydırmaz ve aynı satır için ikinci kayıt eklenmez.
        entries.push({ id, source: current.source, opens_at_ms: current.opens_at_ms });
        if (entries.length > ENTRIES_PER_BASE) entries.shift();
        remember(byContent, base, entries);
      }
    }

    return finding;
  }

  function snapshot() {
    return {
      rows: counters.rows,
      keyCollisions: counters.keyCollisions,
      splitRows: counters.splitRows,
      trackedKeys: byKey.size,
      samples: samples.map(({ key, ...sample }) => sample)
    };
  }

  return { observe, snapshot };
}
