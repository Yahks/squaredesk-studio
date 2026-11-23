import crypto from 'node:crypto';

export interface ParsedSquareComment {
  id: string;
  author: string;
  author_handle: string;
  author_avatar: string;
  user_label: string;
  created_at_label: string;
  content: string;
  likes: string;
  replies_count: string;
  views: string;
  is_thread_reply: boolean;
  post_url: string;
}

export interface ParsedSquarePost {
  id: string;
  external_id: string;
  author: string;
  author_handle: string;
  author_avatar: string;
  post_url: string;
  content: string;
  cashtags: string[];
  hashtags: string[];
  media_urls: string[];
  engagement_metrics: {
    comments: string;
    quotes: string;
    likes: string;
    views: string;
    timestamp_label: string;
  };
  comments: ParsedSquareComment[];
}

export interface DiscoveredFeedLink {
  id: string;
  postUrl: string;
  previewPost?: ParsedSquarePost;
}

export function normalizePostContent(content: string): string {
  return (content || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function computePostContentHash(content: string): string {
  const normalized = normalizePostContent(content);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n');
}

function stripTags(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeOrigin(origin?: string): string {
  const fallback = 'https://www.binance.com';
  if (!origin) return fallback;
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host}`;
  } catch {
    return fallback;
  }
}

function resolvePostUrl(block: string, postId: string, origin?: string): string {
  const baseOrigin = normalizeOrigin(origin);
  const prefetchMatch = block.match(/data-prefetch-path="([^"]*\/square\/post\/\d+[^"]*)"/i);
  if (prefetchMatch && prefetchMatch[1]) {
    const pathPart = prefetchMatch[1].startsWith('/') ? prefetchMatch[1] : `/${prefetchMatch[1]}`;
    return `${baseOrigin}${pathPart}`;
  }
  const hrefMatch = block.match(/href="((?:https?:\/\/[^"]+)?(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/square\/post\/\d+[^"]*)"/i);
  if (hrefMatch && hrefMatch[1]) {
    if (/^https?:\/\//i.test(hrefMatch[1])) return hrefMatch[1];
    return `${baseOrigin}${hrefMatch[1].startsWith('/') ? hrefMatch[1] : `/${hrefMatch[1]}`}`;
  }
  return `${baseOrigin}/en/square/post/${postId}`;
}

/**
 * Extracts inner HTML of the first element whose opening <tag ...> matches `openTagRegex`,
 * properly tracking nested <div ...> ... </div> depth so nested elements inside rich text
 * or #articleBody never truncate early.
 */
function extractBalancedTagInnerHtml(html: string, openTagRegex: RegExp, tagName = 'div'): string {
  const match = openTagRegex.exec(html);
  if (!match) return '';

  const contentStart = match.index + match[0].length;
  const tokenRegex = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tokenRegex.lastIndex = contentStart;

  let depth = 1;
  let token: RegExpExecArray | null;
  while ((token = tokenRegex.exec(html)) !== null) {
    if (token[0].startsWith(`</`)) {
      depth--;
      if (depth === 0) {
        return html.slice(contentStart, token.index);
      }
    } else if (!token[0].endsWith('/>')) {
      depth++;
    }
  }

  return html.slice(contentStart, Math.min(html.length, contentStart + 25000));
}

function splitFeedCardBlocks(html: string): string[] {
  let cardBlocks = html.split(/class="[^"]*FeedBuzzBaseViewRootBox[^"]*"/g).slice(1);
  if (cardBlocks.length === 0) {
    cardBlocks = html.split(/(?=<[^>]+data-id="\d+")/g).filter((b) => /data-id="\d+"/.test(b));
  }
  return cardBlocks;
}

function extractPostContentFromBlock(block: string, postId: string): string {
  const canonicalAnchorMatch = block.match(
    new RegExp(`<a[^>]+href="[^"]*\\/square\\/post\\/${postId}[^"]*"[^>]*>([\\s\\S]*?)</a>`, 'i')
  );
  const richTextInner = extractBalancedTagInnerHtml(block, /<div[^>]*class="[^"]*card__description[^"]*rich-text[^"]*"[^>]*>/i);
  const feedContentInner = extractBalancedTagInnerHtml(block, /<div[^>]*class="[^"]*feed-content-text[^"]*"[^>]*>/i);

  const candidates = [
    canonicalAnchorMatch ? stripTags(canonicalAnchorMatch[1]) : '',
    richTextInner ? stripTags(richTextInner) : '',
    feedContentInner ? stripTags(feedContentInner) : '',
  ].filter(Boolean);

  return candidates.sort((a, b) => b.length - a.length)[0] || '';
}

export function parseBinanceSquareHtml(html: string, origin?: string): ParsedSquarePost[] {
  const results: ParsedSquarePost[] = [];
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();

  const cardBlocks = splitFeedCardBlocks(html);
  const blocksToInspect = cardBlocks.length > 0 ? cardBlocks : [html];

  for (const block of blocksToInspect) {
    const idMatch =
      block.match(/data-id="(\d+)"/) ||
      block.match(/(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/square\/post\/(\d+)/);
    if (!idMatch) continue;
    const postId = idMatch[1];
    if (seenIds.has(postId)) continue;

    const authorMatch = block.match(/class="nick[^"]*"[^>]*>([^<]+)<\/a>/);
    const author = authorMatch ? decodeHtmlEntities(authorMatch[1]).trim() : 'Binance Square Creator';

    const handleMatch = block.match(/href="(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/square\/profile\/([^"?]+)"/);
    const author_handle = handleMatch ? `@${handleMatch[1]}` : '@square_creator';

    const avatarMatch =
      block.match(/class="avatar-img"[^>]*src="([^"]+)"/) ||
      block.match(/src="(https:\/\/public\.bnbstatic\.com\/image\/pgc\/[^"]+)"/);
    const author_avatar = avatarMatch ? avatarMatch[1] : '';

    const content = extractPostContentFromBlock(block, postId);
    if (!content) continue;

    const contentHash = computePostContentHash(content);
    if (seenHashes.has(contentHash)) continue;

    seenIds.add(postId);
    seenHashes.add(contentHash);

    const hashtagMatches = [...content.matchAll(/#([A-Za-z0-9_]+)/g)].map((m) => `#${m[1]}`);
    const cashtagMatches = [...content.matchAll(/\$([A-Za-z]{2,10})\b/g)].map((m) => `$${m[1].toUpperCase()}`);

    const mediaUrls: string[] = [];
    const videoMatch = block.match(/<video[^>]+src="([^"]+)"/i);
    if (videoMatch) mediaUrls.push(videoMatch[1]);
    const posterMatch = block.match(/art-poster"[^>]*style="[^"]*url\((?:&quot;|")?([^"&)]+)/i);
    if (posterMatch) mediaUrls.push(posterMatch[1]);
    const imgMatches = [...block.matchAll(/<img[^>]+src="(https:\/\/public\.bnbstatic\.com\/[^"]+)"/gi)];
    for (const im of imgMatches) {
      if (!im[1].includes('small_official') && im[1] !== author_avatar && !mediaUrls.includes(im[1])) {
        mediaUrls.push(im[1]);
      }
    }

    const timeMatch = block.match(/class="create-time"[^>]*>([^<]+)<\/(?:div|span)>/i);
    const commentMatch = block.match(/comments-icon[\s\S]*?<span class="current[^"]*">([^<]+)<\/span>/i);
    const quoteMatch = block.match(/quote-icon[\s\S]*?<span class="current[^"]*">([^<]+)<\/span>/i);
    const likeMatch = block.match(/thumb-up-button[\s\S]*?<span class="current[^"]*">([^<]+)<\/span>/i);
    const viewMatch = block.match(/view-counts[\s\S]*?<span class="current[^"]*">([^<]+)<\/span>/i);

    results.push({
      id: postId,
      external_id: postId,
      author,
      author_handle,
      author_avatar,
      post_url: resolvePostUrl(block, postId, origin),
      content,
      cashtags: Array.from(new Set(cashtagMatches)),
      hashtags: Array.from(new Set(hashtagMatches)),
      media_urls: mediaUrls,
      engagement_metrics: {
        comments: commentMatch ? commentMatch[1].trim() : '0',
        quotes: quoteMatch ? quoteMatch[1].trim() : '0',
        likes: likeMatch ? likeMatch[1].trim() : '0',
        views: viewMatch ? viewMatch[1].trim() : '0',
        timestamp_label: timeMatch ? timeMatch[1].trim() : 'now',
      },
      comments: [],
    });
  }

  return results;
}

/**
 * Phase 1 helper: collects unique post IDs + canonical post URLs from feed HTML,
 * along with preview card data as fallback.
 */
export function parseBinanceSquareFeedLinks(html: string, origin?: string): DiscoveredFeedLink[] {
  const previewPosts = parseBinanceSquareHtml(html, origin);
  const previewById = new Map<string, ParsedSquarePost>();
  for (const p of previewPosts) {
    previewById.set(p.external_id, p);
  }

  const baseOrigin = normalizeOrigin(origin);
  const seenIds = new Set<string>();
  const links: DiscoveredFeedLink[] = [];

  const cardBlocks = splitFeedCardBlocks(html);
  for (const block of cardBlocks) {
    const idMatch =
      block.match(/data-id="(\d+)"/) ||
      block.match(/data-prefetch-path="(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/square\/post\/(\d+)/i) ||
      block.match(/(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/square\/post\/(\d+)/i);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    links.push({
      id,
      postUrl: resolvePostUrl(block, id, baseOrigin),
      previewPost: previewById.get(id),
    });
  }

  // Fallback sweep across raw href/data-prefetch-path matches if card wrappers differ
  const hrefRegex = /(?:data-prefetch-path|href)="((?:https?:\/\/[^"]+)?(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/square\/post\/(\d+)[^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRegex.exec(html)) !== null) {
    const rawPath = m[1];
    const id = m[2];
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const fullUrl = /^https?:\/\//i.test(rawPath)
      ? rawPath
      : `${baseOrigin}${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`;
    links.push({
      id,
      postUrl: fullUrl,
      previewPost: previewById.get(id),
    });
  }

  return links;
}

export function parseCommentsFromSectionHtml(
  commentsHtml: string,
  options?: { mainPostId?: string; origin?: string }
): ParsedSquareComment[] {
  const comments: ParsedSquareComment[] = [];
  const seenKeys = new Set<string>();
  const baseOrigin = normalizeOrigin(options?.origin);

  const virtuosoInner = extractBalancedTagInnerHtml(
    commentsHtml,
    /<div[^>]*data-testid="virtuoso-item-list"[^>]*>/i
  );
  const scopedHtml = virtuosoInner || commentsHtml;

  const cardBlocks = splitFeedCardBlocks(scopedHtml);
  for (const block of cardBlocks) {
    const idMatch =
      block.match(/data-id="(\d+)"/) ||
      block.match(/(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/square\/post\/(\d+)/);
    const commentId = idMatch ? idMatch[1] : '';
    if (options?.mainPostId && commentId === options.mainPostId) {
      continue;
    }

    const authorMatch = block.match(/class="nick[^"]*"[^>]*>([^<]+)<\/a>/);
    const author = authorMatch ? decodeHtmlEntities(authorMatch[1]).trim() : '';

    const handleMatch = block.match(/href="(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/square\/profile\/([^"?]+)"/);
    const author_handle = handleMatch ? `@${handleMatch[1]}` : '@square_user';

    const avatarMatch =
      block.match(/class="avatar-img"[^>]*src="([^"]+)"/) ||
      block.match(/src="(https:\/\/(?:public|bin)\.bnbstatic\.com\/[^"]+)"/i);
    const author_avatar = avatarMatch ? avatarMatch[1] : '';

    const labelMatch = block.match(/class="[^"]*user-label[^"]*"[^>]*>([^<]+)<\/div>/i);
    const user_label = labelMatch ? decodeHtmlEntities(labelMatch[1]).trim() : '';

    const timeMatch = block.match(/class="create-time"[^>]*>([^<]+)<\/(?:div|span)>/i);
    const created_at_label = timeMatch ? decodeHtmlEntities(timeMatch[1]).trim() : '';

    const cardDescInner = extractBalancedTagInnerHtml(block, /<div[^>]*class="[^"]*card__description[^"]*rich-text[^"]*"[^>]*>/i);
    const feedContentInner = extractBalancedTagInnerHtml(block, /<div[^>]*class="[^"]*feed-content-text[^"]*"[^>]*>/i);
    const richTextInner = extractBalancedTagInnerHtml(block, /<div[^>]*class="[^"]*rich-text[^"]*"[^>]*>/i);
    const content = [cardDescInner, feedContentInner, richTextInner]
      .map((raw) => (raw ? stripTags(raw) : ''))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] || '';
    if (!content) continue;

    const dedupeKey = commentId || `${author_handle}:${computePostContentHash(content)}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    const commentMatch = block.match(/comments-icon[\s\S]*?<span class="current[^"]*">([^<]+)<\/span>/i);
    const likeMatch = block.match(/thumb-up-button[\s\S]*?<span class="current[^"]*">([^<]+)<\/span>/i);
    const viewMatch = block.match(/view-counts[\s\S]*?<span class="current[^"]*">([^<]+)<\/span>/i);

    comments.push({
      id: commentId || `cmt_${dedupeKey.slice(0, 16)}`,
      author: author || author_handle,
      author_handle,
      author_avatar,
      user_label,
      created_at_label: created_at_label || 'recent',
      content,
      likes: likeMatch ? likeMatch[1].trim() : '0',
      replies_count: commentMatch ? commentMatch[1].trim() : '0',
      views: viewMatch ? viewMatch[1].trim() : '0',
      is_thread_reply: /in-thread-card/i.test(block),
      post_url: commentId ? resolvePostUrl(block, commentId, baseOrigin) : '',
    });
  }

  return comments;
}

/**
 * Phase 2 helper: parses a single Binance Square post detail page HTML into the full post
 * plus all mounted comments under #comment / [data-testid="virtuoso-item-list"].
 */
export function parseBinanceSquarePostDetailHtml(
  html: string,
  options?: {
    postId?: string;
    postUrl?: string;
    origin?: string;
    fallbackPost?: ParsedSquarePost;
  }
): { post: ParsedSquarePost; expectedRepliesCount: number } | null {
  const commentBoundaryMatch =
    /<div[^>]*id="comment"[^>]*>/i.exec(html) ||
    /data-testid="virtuoso-item-list"/i.exec(html);

  const mainHtml = commentBoundaryMatch ? html.slice(0, commentBoundaryMatch.index) : html;
  const commentsHtml = commentBoundaryMatch ? html.slice(commentBoundaryMatch.index) : '';

  const fallback = options?.fallbackPost;
  const postId =
    options?.postId ||
    fallback?.id ||
    mainHtml.match(/(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/square\/post\/(\d+)/i)?.[1] ||
    mainHtml.match(/data-id="(\d+)"/)?.[1] ||
    '';

  if (!postId && !fallback) {
    return null;
  }

  // Scope author extraction to the detail header before #articleBody if available
  const detailBlock =
    extractBalancedTagInnerHtml(mainHtml, /<div[^>]*class="[^"]*post-detail-content-block[^"]*"[^>]*>/i) ||
    extractBalancedTagInnerHtml(mainHtml, /<div[^>]*class="[^"]*post-detail-article[^"]*"[^>]*>/i) ||
    mainHtml;

  const authorMatch = detailBlock.match(/class="nick[^"]*"[^>]*>([^<]+)<\/a>/);
  const author =
    (authorMatch ? decodeHtmlEntities(authorMatch[1]).trim() : '') ||
    fallback?.author ||
    'Binance Square Creator';

  const handleMatch = detailBlock.match(/href="(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/square\/profile\/([^"?]+)"/);
  const author_handle =
    (handleMatch ? `@${handleMatch[1]}` : '') ||
    fallback?.author_handle ||
    '@square_creator';

  const avatarMatch =
    detailBlock.match(/class="avatar-img"[^>]*src="([^"]+)"/) ||
    detailBlock.match(/src="(https:\/\/public\.bnbstatic\.com\/image\/pgc\/[^"]+)"/);
  const author_avatar = (avatarMatch ? avatarMatch[1] : '') || fallback?.author_avatar || '';

  // Full detail body (#articleBody / title / rich-text)
  const titleMatch =
    detailBlock.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    detailBlock.match(/class="[^"]*article-title[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const articleTitle = titleMatch ? stripTags(titleMatch[1]) : '';

  const articleBodyInner = extractBalancedTagInnerHtml(detailBlock, /<div[^>]*id="articleBody"[^>]*>/i);
  const articleRichText = articleBodyInner
    ? extractBalancedTagInnerHtml(articleBodyInner, /<div[^>]*class="[^"]*card__description[^"]*rich-text[^"]*"[^>]*>/i) || articleBodyInner
    : extractBalancedTagInnerHtml(detailBlock, /<div[^>]*class="[^"]*card__description[^"]*rich-text[^"]*"[^>]*>/i);

  let bodyText = articleRichText ? stripTags(articleRichText) : '';
  if (!bodyText && postId) {
    bodyText = extractPostContentFromBlock(detailBlock, postId);
  }
  if (!bodyText && fallback?.content) {
    bodyText = fallback.content;
  }

  let fullContent = bodyText;
  if (articleTitle && bodyText && !bodyText.startsWith(articleTitle)) {
    fullContent = `${articleTitle}\n\n${bodyText}`;
  } else if (articleTitle && !bodyText) {
    fullContent = articleTitle;
  }

  if (!fullContent) {
    return null;
  }

  const hashtagMatches = [...fullContent.matchAll(/#([A-Za-z0-9_]+)/g)].map((m) => `#${m[1]}`);
  const cashtagMatches = [...fullContent.matchAll(/\$([A-Za-z]{2,10})\b/g)].map((m) => `$${m[1].toUpperCase()}`);

  const mediaUrls: string[] = [...(fallback?.media_urls || [])];
  const videoMatch = detailBlock.match(/<video[^>]+src="([^"]+)"/i);
  if (videoMatch && !mediaUrls.includes(videoMatch[1])) mediaUrls.push(videoMatch[1]);
  const imgMatches = [...detailBlock.matchAll(/<img[^>]+src="(https:\/\/public\.bnbstatic\.com\/[^"]+)"/gi)];
  for (const im of imgMatches) {
    if (!im[1].includes('small_official') && im[1] !== author_avatar && !mediaUrls.includes(im[1])) {
      mediaUrls.push(im[1]);
    }
  }

  const timeMatch = detailBlock.match(/class="create-time"[^>]*>([^<]+)<\/(?:div|span)>/i);
  const likeMatch = mainHtml.match(/thumb-up-button[\s\S]*?<span class="current[^"]*">([^<]+)<\/span>/i);
  const viewMatch = mainHtml.match(/view-counts[\s\S]*?<span class="current[^"]*">([^<]+)<\/span>/i);
  const quoteMatch = mainHtml.match(/quote-icon[\s\S]*?<span class="current[^"]*">([^<]+)<\/span>/i);
  const repliesTabMatch = html.match(/role="tab"[^>]*>[\s\S]*?(?:Replies|Comments)\s+(\d+)/i);
  const commentIconMatch = mainHtml.match(/comments-icon[\s\S]*?<span class="current[^"]*">([^<]+)<\/span>/i);

  const comments = commentsHtml
    ? parseCommentsFromSectionHtml(commentsHtml, { mainPostId: postId, origin: options?.origin })
    : [];

  const expectedRepliesCount = repliesTabMatch ? Number(repliesTabMatch[1]) || 0 : 0;
  const resolvedCommentCount =
    repliesTabMatch?.[1] ||
    (comments.length > 0 ? String(comments.length) : '') ||
    commentIconMatch?.[1]?.trim() ||
    fallback?.engagement_metrics?.comments ||
    '0';

  const resolvedOrigin = normalizeOrigin(options?.origin);
  const resolvedUrl =
    options?.postUrl ||
    fallback?.post_url ||
    `${resolvedOrigin}/en/square/post/${postId}`;

  return {
    post: {
      id: postId,
      external_id: postId,
      author,
      author_handle,
      author_avatar,
      post_url: resolvedUrl,
      content: fullContent,
      cashtags: Array.from(new Set([...(fallback?.cashtags || []), ...cashtagMatches])),
      hashtags: Array.from(new Set([...(fallback?.hashtags || []), ...hashtagMatches])),
      media_urls: mediaUrls,
      engagement_metrics: {
        comments: resolvedCommentCount,
        quotes: quoteMatch ? quoteMatch[1].trim() : fallback?.engagement_metrics?.quotes || '0',
        likes: likeMatch ? likeMatch[1].trim() : fallback?.engagement_metrics?.likes || '0',
        views: viewMatch ? viewMatch[1].trim() : fallback?.engagement_metrics?.views || '0',
        timestamp_label: timeMatch ? timeMatch[1].trim() : fallback?.engagement_metrics?.timestamp_label || 'now',
      },
      comments,
    },
    expectedRepliesCount,
  };
}

