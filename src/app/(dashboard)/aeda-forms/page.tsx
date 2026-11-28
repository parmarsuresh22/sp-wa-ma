import { Suspense } from 'react';

import { AedaFrame } from '@/components/foms/aeda-frame';

/**
 * AEDA Forms (migration 091): the original FOMS application, shown as
 * it is. Platform admin only while the module is being tried out; the
 * server answers "not found" to everyone else.
 */
export default function AedaFormsPage() {
  return (
    // The frame reads the address (?p= is the page open inside it).
    <Suspense fallback={null}>
      <AedaFrame />
    </Suspense>
  );
}
