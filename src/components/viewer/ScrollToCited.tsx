'use client';

import { useEffect } from 'react';

/** The header stays on top of the page, so cited lines carry a scroll margin for its height. */
export function ScrollToCited() {
  useEffect(() => {
    document.querySelector('[data-cited]')?.scrollIntoView({ block: 'start' });
  }, []);

  return null;
}
