import { useEffect, useState } from 'react';

/**
 * Display only. The server owns the deadline and is what actually ends a turn;
 * this just renders the gap between now and that deadline. `clockOffset`
 * corrects for a browser clock that disagrees with the server's.
 */
export function Timer({ deadline, clockOffset }: { deadline: number; clockOffset: number }) {
  const [now, setNow] = useState(() => Date.now() + clockOffset);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + clockOffset), 200);
    return () => clearInterval(id);
  }, [clockOffset]);

  const remaining = Math.max(0, deadline - now);
  const seconds = Math.ceil(remaining / 1000);

  return (
    <span
      className={`timer${seconds <= 5 ? ' urgent' : ''}`}
      role="timer"
      aria-label={`${seconds} seconds left this turn`}
    >
      {seconds}s
    </span>
  );
}
