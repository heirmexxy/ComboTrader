// Shared shapes for the content library.
export interface LibraryPost { slug: string; title: string; category: 'guides' | 'from-the-farm' | 'market-watch' | 'champion-stories'; excerpt: string; body: string }
export interface LibraryNewsletter { n: number; theme: string; subject: string; subject_b: string; body: string }
