import type { Metadata } from 'next';

import { PublicForm } from '@/components/aeda-forms/public-form';

export const metadata: Metadata = {
  title: 'Form',
  robots: { index: false, follow: false },
};

/**
 * The public link of an AEDA form (migration 089). No sign-in: the long
 * random token in the address is the permission, and it reaches only
 * this one form.
 */
export default async function PublicFormPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicForm token={token} />;
}
