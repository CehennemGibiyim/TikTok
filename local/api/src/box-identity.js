/*
 * box-identity.js — içerik tabanı ve kalıcı parmak izi.
 *
 * İki depo (Postgres ve bellek içi) aynı kuralı uygulasın diye tek yerde:
 *
 * - `contentBase`: kaynak kimliğinden bağımsız kimlik (oda | yayıncı | tür).
 * - `contentFingerprint`: taban + açılış zamanının pencereye yuvarlanması.
 *   `events.content_fingerprint` kolonuna yazılır ve tekillik kuralıyla
 *   aynı penceredeki ikinci satırı engeller.
 *
 * Pencere yalnızca birebir eşleşen hızlı yoldur. Farklı pencerelere düşen
 * yakın zamanları depolar taban + |zaman farkı| <= tolerans aramasıyla
 * birleştirir; yani sınır ötesi fark da tek satıra iner.
 */

export const CONTENT_TOLERANCE_MS = 5000;

export function contentBase(event) {
  if (!event) return null;
  const creator = String(event.creator || '').trim().toLowerCase();
  const opensAt = Number(event.opens_at_ms) || 0;
  if (!creator || opensAt <= 0) return null;
  const kind = event.kind === 'bag' ? 'bag' : 'chest';
  return [String(event.room_id || '').trim(), creator, kind].join('|');
}

export function contentFingerprint(event) {
  const base = contentBase(event);
  if (!base) return null;
  return base + '|' + Math.floor((Number(event.opens_at_ms) || 0) / CONTENT_TOLERANCE_MS);
}
