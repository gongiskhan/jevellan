/**
 * Times and durations in the owner tools' copy (bridge specification, "Conventions for all output"): `14:02` today, `yesterday 23:10`,
 * `Mon 18 Oct 02:00` beyond, always in the project's time zone so the text never depends on the machine.
 */
const parts = (at: Date, timeZone: string) => {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'short', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map(part => [part.type, part.value]));
  return { day: `${values.year}-${values.month}-${values.day}`, clock: `${values.hour}:${values.minute}`, weekday: values.weekday!, dayOfMonth: String(Number(values.day)), month: values.month! };
};

export function ownerClock(at: string | Date, now: string | Date, timeZone: string): string {
  const when = parts(new Date(at), timeZone), today = parts(new Date(now), timeZone);
  if (when.day === today.day) return when.clock;
  const yesterday = parts(new Date(new Date(now).getTime() - 24 * 3600_000), timeZone);
  if (when.day === yesterday.day) return `yesterday ${when.clock}`;
  return `${when.weekday} ${when.dayOfMonth} ${when.month} ${when.clock}`;
}

export function ownerDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** The project's local `HH:MM` and calendar day for a moment, for windows and quiet hours. */
export function ownerLocal(at: string | Date, timeZone: string): { day: string; clock: string } {
  const value = parts(new Date(at), timeZone); return { day: value.day, clock: value.clock };
}
