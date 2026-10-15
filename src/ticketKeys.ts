const ticketKeyPattern = /\b[A-Z][A-Z0-9]+-\d+\b/giu;

export function extractTicketKeys(values: readonly (string | undefined)[]): string[] {
  const ticketKeys = new Set<string>();

  values.forEach((value) => {
    if (!value) {
      return;
    }

    Array.from(value.matchAll(ticketKeyPattern)).forEach((match) => {
      const ticketKey = match[0];

      if (!ticketKey) {
        return;
      }

      ticketKeys.add(ticketKey.toUpperCase());
    });
  });

  return Array.from(ticketKeys).sort();
}
