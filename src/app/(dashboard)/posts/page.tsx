'use client';

import { Suspense } from 'react';
import { PostsStudio } from '@/components/posts/posts-studio';

// `useSearchParams` (the "?drive=connected" outcome of connecting Google
// Drive) needs a Suspense boundary or the page bails out of prerendering.
export default function PostsPage() {
  return (
    <Suspense fallback={null}>
      <PostsStudio />
    </Suspense>
  );
}
