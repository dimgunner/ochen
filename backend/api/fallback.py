"""
Local semantic fallback for metaphor interpretation.

Used when the LLM provider is unavailable or returns an invalid answer.
Matching is based on the tags and synonyms already stored in the manifest,
so adding a new asset automatically improves the fallback.
"""

import re

# Words that carry no signal for object selection
STOP_WORDS = {
    'и', 'в', 'на', 'с', 'о', 'об', 'для', 'не', 'что', 'как', 'это',
    'the', 'a', 'an', 'of', 'to', 'and', 'or', 'for', 'with', 'is', 'are',
}


def tokenize(text):
    """Split text into lowercase word tokens."""
    words = re.findall(r'[a-zA-Zа-яА-ЯёЁ]+', (text or '').lower())
    return [w for w in words if w not in STOP_WORDS]


def build_index(variants):
    """
    Build an inverted index: token -> list of asset ids.

    Synonyms and tags of every main-state asset become searchable tokens.
    """
    index = {}
    seen = set()

    for v in variants:
        if v.get('state') != 'main':
            continue
        asset_id = v.get('assetId')
        if not asset_id or asset_id in seen:
            continue
        seen.add(asset_id)

        tokens = set()
        tokens.update(tokenize(v.get('name', '')))
        for syn in v.get('synonyms', []) or []:
            tokens.update(tokenize(syn))
        for tag in v.get('tags', []) or []:
            tokens.update(tokenize(tag))

        for token in tokens:
            index.setdefault(token, []).append(asset_id)

    return index


# Words shorter than this are matched exactly only; a short stem would match
# far too many unrelated words.
STEM_LENGTH = 4
MIN_STEM_WORD = 5


def stem_hits(token, index):
    """
    Words that share a stem with the token.

    Russian words change endings, so 'обучению' has to match the stored
    'обучение'. Comparing the first few letters is enough for this catalog.
    """
    if len(token) < MIN_STEM_WORD:
        return []
    stem = token[:STEM_LENGTH]
    hits = set()
    for key, asset_ids in index.items():
        if len(key) >= MIN_STEM_WORD and key[:STEM_LENGTH] == stem:
            hits.update(asset_ids)
    return hits


def build_background_index(variants):
    """
    Build an index of objects that declare themselves suitable as a
    background for a theme.

    Kept separate from the main-object vocabulary: a background candidate
    must not compete with the main objects for a place in the composition.
    """
    index = {}
    for v in variants:
        if v.get('state') != 'main':
            continue
        asset_id = v.get('assetId')
        if not asset_id:
            continue
        for word in v.get('backgroundFor', []) or []:
            for token in tokenize(word):
                index.setdefault(token, [])
                if asset_id not in index[token]:
                    index[token].append(asset_id)
    return index


def pick_background(text, index, exclude, default_id=None, background_index=None):
    """
    Choose one object for the background role.

    Priority:
      1. an object declared in the manifest as fitting this theme as a
         background (for example the folder for finance);
      2. the best object that is not already used as a main object;
      3. the default decorative object.
    """
    tokens = tokenize(text)

    if background_index:
        declared = {}
        for token in tokens:
            hits = background_index.get(token) or stem_hits(token, background_index)
            for asset_id in hits:
                if asset_id in exclude:
                    continue
                declared[asset_id] = declared.get(asset_id, 0) + len(token)
        if declared:
            ranked = sorted(declared.items(), key=lambda kv: (-kv[1], kv[0]))
            return ranked[0][0]

    scores = {}
    for token in tokens:
        hits = index.get(token) or stem_hits(token, index)
        for asset_id in hits:
            if asset_id in exclude:
                continue
            scores[asset_id] = scores.get(asset_id, 0) + len(token)

    if scores:
        ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
        for asset_id, _ in ranked:
            if asset_id not in exclude:
                return asset_id

    if default_id and default_id not in exclude:
        return default_id
    return None


def match(text, index, max_objects=3):
    """
    Score assets by token overlap and return the best matches.

    Longer tokens weigh more, so 'технологии' outranks 'тех'. A word that
    is not stored verbatim is matched by its stem, which covers the common
    Russian case endings.
    """
    tokens = tokenize(text)
    if not tokens or not index:
        return []

    scores = {}
    for token in tokens:
        hits = index.get(token) or stem_hits(token, index)
        for asset_id in hits:
            scores[asset_id] = scores.get(asset_id, 0) + len(token)

    if not scores:
        return []

    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    return [asset_id for asset_id, _ in ranked[:max_objects]]
