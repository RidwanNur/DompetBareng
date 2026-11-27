export function getDailyAiLimit() {
  const configured = process.env.TELEGRAM_DAILY_AI_LIMIT?.trim();
  if (configured && /^[1-9][0-9]*$/.test(configured)) {
    const limit = Number(configured);
    if (Number.isSafeInteger(limit) && limit <= 2_147_483_647) return limit;
  }
  return 60;
}

export function aiQuotaMessage(limit: number) {
  return `Kuota input AI harian tercapai (${limit}/${limit}). Catat manual lewat PWA atau coba lagi besok.`;
}
