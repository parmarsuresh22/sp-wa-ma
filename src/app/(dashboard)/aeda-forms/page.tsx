import { Suspense } from 'react';

import { FormsStudio } from '@/components/aeda-forms/forms-studio';

/**
 * AEDA Forms (migration 089). Shown to the platform admin only while
 * the module is being tried out; the server answers "not found" to
 * everyone else, and the page then says it is not available.
 */
export default function AedaFormsPage() {
  return (
    // The studio reads the address (?project=, ?form=, ?view=).
    <Suspense fallback={null}>
      <FormsStudio />
    </Suspense>
  );
}
