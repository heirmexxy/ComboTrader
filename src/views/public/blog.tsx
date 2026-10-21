import { useC } from '../render';
import { PublicLayout } from '../layout';
import { Csrf, Empty } from '../components';
import { PageHead } from './pages';
import { fmtDate } from '../../lib/i18n';
import { config } from '../../lib/config';
import { FaXTwitter, FaFacebook, FaLinkedin, FaWhatsapp } from 'react-icons/fa6';

export interface Post { id: number; slug: string; lang: string; title: string; excerpt: string | null; body: string; category: string; author: string; cover_path: string | null; publish_at: string | null; created_at: string }
export const CATEGORIES = ['market-watch', 'champion-stories', 'from-the-farm', 'guides'];

function Cover({ p }: { p: Post }) {
  return p.cover_path
    ? <img className="post-cover" src={`/uploads/${p.cover_path}`} alt="" loading="lazy" />
    : <div className={`post-cover placeholder cat-${p.category}`} aria-hidden="true" />;
}

export function ChroniclesPage({ posts, cat, search }: { posts: Post[]; cat?: string; search?: string }) {
  const c = useC();
  return (
    <PublicLayout title={c.t('blog.title')} description={c.t('blog.intro')}>
      <PageHead title={c.t('blog.title')} intro={c.t('blog.intro')} />
      <section className="section"><div className="container">
        <div className="blog-bar">
          <nav className="chips" aria-label="Categories">
            <a href="/chronicles" aria-current={!cat ? 'page' : undefined}>{c.t('blog.all')}</a>
            {CATEGORIES.map((k) => <a key={k} href={`/chronicles?cat=${k}`} aria-current={cat === k ? 'page' : undefined}>{c.t(`blog.cat.${k}`)}</a>)}
          </nav>
          <form method="get" action="/chronicles" className="inline-form" role="search">
            <label className="sr-only" htmlFor="q">{c.t('blog.search')}</label>
            <input id="q" type="search" name="q" defaultValue={search} placeholder={c.t('blog.search')} />
          </form>
        </div>
        {posts.length === 0 ? <Empty>{c.t('blog.empty')}</Empty> : (
          <div className="grid-3">
            {posts.map((p) => (
              <article key={p.id} className="card post-card">
                <a href={`/chronicles/${p.slug}`} tabIndex={-1} aria-hidden="true"><Cover p={p} /></a>
                <p className="eyebrow dark">{c.t(`blog.cat.${p.category}`)}</p>
                <h3><a href={`/chronicles/${p.slug}`}>{p.title}</a></h3>
                {p.excerpt && <p>{p.excerpt}</p>}
                <p className="muted small">{fmtDate(c.lang, p.publish_at || p.created_at)} · {c.t('blog.min_read', { n: Math.max(1, Math.round(p.body.split(/\s+/).length / 220)) })}</p>
              </article>
            ))}
          </div>
        )}
      </div></section>
    </PublicLayout>
  );
}

export function PostPage({ post, html, related, fallback }: { post: Post; html: string; related: Post[]; fallback: boolean }) {
  const c = useC();
  const url = `${config.baseUrl}/chronicles/${post.slug}`;
  const enc = encodeURIComponent;
  return (
    <PublicLayout title={post.title} description={post.excerpt || undefined}>
      <article>
        <header className="page-head"><div className="container narrow">
          <p className="eyebrow"><a href={`/chronicles?cat=${post.category}`}>{c.t(`blog.cat.${post.category}`)}</a></p>
          <h1>{post.title}</h1>
          <p className="lead small">{c.t('blog.by', { author: post.author })} · {fmtDate(c.lang, post.publish_at || post.created_at)}</p>
        </div></header>
        <div className="container narrow section">
          {fallback && <p className="flash flash-info">{c.t('blog.english_only')}</p>}
          {post.cover_path && <img className="post-hero" src={`/uploads/${post.cover_path}`} alt="" />}
          <div className="prose" lang={post.lang} dangerouslySetInnerHTML={{ __html: html }} />
          <div className="share-row">
            <span>{c.t('blog.share')}:</span>
            <a href={`https://wa.me/?text=${enc(post.title + ' ' + url)}`} target="_blank" rel="noopener" aria-label="WhatsApp"><FaWhatsapp /></a>
            <a href={`https://x.com/intent/post?text=${enc(post.title)}&url=${enc(url)}`} target="_blank" rel="noopener" aria-label="X"><FaXTwitter /></a>
            <a href={`https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`} target="_blank" rel="noopener" aria-label="Facebook"><FaFacebook /></a>
            <a href={`https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`} target="_blank" rel="noopener" aria-label="LinkedIn"><FaLinkedin /></a>
          </div>
          <aside className="card nl-box">
            <h3>{c.t('nl.title')}</h3><p>{c.t('footer.newsletter_sub')}</p>
            <form method="post" action="/newsletter" className="inline-form"><Csrf />
              <input type="email" name="email" required placeholder={c.t('footer.email_ph')} aria-label={c.t('auth.email')} />
              <button className="btn btn-primary" type="submit">{c.t('footer.subscribe')}</button></form>
          </aside>
        </div>
      </article>
      {related.length > 0 && <section className="section alt"><div className="container"><h2>{c.t('blog.related')}</h2><div className="grid-3">
        {related.map((p) => <article key={p.id} className="card post-card"><Cover p={p} /><h3><a href={`/chronicles/${p.slug}`}>{p.title}</a></h3><p>{p.excerpt}</p></article>)}
      </div></div></section>}
    </PublicLayout>
  );
}
