'use client';

export default function Dashboard({ params }: { params: { id: string } }) {
  return <section data-id={params.id}>Dashboard</section>;
}
