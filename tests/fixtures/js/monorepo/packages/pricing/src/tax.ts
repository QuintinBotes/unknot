const RATES: Record<string, number> = { DE: 0.19, FR: 0.2 };

export function vat(region: string): number {
  return RATES[region] ?? 0;
}

export default function defaultRate() {
  return 0.2;
}
