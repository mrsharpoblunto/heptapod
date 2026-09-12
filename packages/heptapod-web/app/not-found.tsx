import Link from "next/link";

export default function NotFound() {
  return (
    <main className="review-index">
      <header>
        <h1>Review not found</h1>
        <p>The requested review ID is not present in the local database.</p>
      </header>
      <Link href="/">Return to all reviews</Link>
    </main>
  );
}
