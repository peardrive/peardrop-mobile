import {
  buildDownloads,
  buildRecents,
  dedupeByUri,
  folderDisplayName,
  mergeFolderListings,
  needsMaterialization,
  shouldShowFolderLabels,
  pageEntries,
  partitionForMaterialization,
  selectedEntries,
  selectionSummary,
  sortBrowseEntries,
  thumbnailFor,
  toDisplayUri,
  toPickedFiles,
  typeBadge,
  type BrowseEntry,
} from "../fileBrowse";

/** Asserts non-empty and hands back row 0 — keeps the strict-index checks happy. */
function first<T>(list: T[]): T {
  expect(list.length).toBeGreaterThan(0);
  return list[0] as T;
}

const entry = (over: Partial<BrowseEntry> = {}): BrowseEntry => ({
  uri: "file:///a.txt",
  name: "a.txt",
  size: 100,
  modifiedAt: 1000,
  source: "recent",
  ...over,
});

describe("sortBrowseEntries", () => {
  it("puts the newest first", () => {
    const out = sortBrowseEntries([
      entry({ uri: "1", name: "old", modifiedAt: 100 }),
      entry({ uri: "2", name: "new", modifiedAt: 900 }),
    ]);
    expect(out.map((e) => e.name)).toEqual(["new", "old"]);
  });

  it("breaks ties by name so ordering is stable across renders", () => {
    const out = sortBrowseEntries([
      entry({ uri: "1", name: "b", modifiedAt: 500 }),
      entry({ uri: "2", name: "a", modifiedAt: 500 }),
    ]);
    expect(out.map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("sorts unknown timestamps last rather than treating them as recent", () => {
    const out = sortBrowseEntries([
      entry({ uri: "1", name: "undated", modifiedAt: undefined }),
      entry({ uri: "2", name: "dated", modifiedAt: 1 }),
    ]);
    expect(out.map((e) => e.name)).toEqual(["dated", "undated"]);
  });

  it("does not mutate its input", () => {
    const input = [
      entry({ uri: "1", name: "old", modifiedAt: 1 }),
      entry({ uri: "2", name: "new", modifiedAt: 9 }),
    ];
    sortBrowseEntries(input);
    expect(input.map((e) => e.name)).toEqual(["old", "new"]);
  });
});

describe("dedupeByUri", () => {
  it("keeps the first occurrence and drops uri-less rows", () => {
    const out = dedupeByUri([
      entry({ uri: "x", name: "first" }),
      entry({ uri: "x", name: "second" }),
      entry({ uri: "", name: "ghost" }),
    ]);
    expect(out.map((e) => e.name)).toEqual(["first"]);
  });
});

describe("buildRecents", () => {
  const history = [
    {
      savedAt: 100,
      files: [{ name: "old.txt", localPath: "file:///old.txt", size: 1 }],
    },
    {
      savedAt: 900,
      files: [
        { name: "new.txt", localPath: "file:///new.txt", size: 2 },
        { name: "also.txt", localPath: "file:///also.txt", size: 3 },
      ],
    },
  ];

  it("flattens share history newest-first", () => {
    const out = buildRecents(history, { limit: 10 });
    expect(out.map((e) => e.name)).toEqual(["also.txt", "new.txt", "old.txt"]);
    expect(out.every((e) => e.source === "recent")).toBe(true);
  });

  it("carries the share timestamp through as the entry date", () => {
    const out = buildRecents(history, { limit: 10 });
    expect(out.find((e) => e.name === "old.txt")?.modifiedAt).toBe(100);
  });

  it("keeps only the newest record of a re-shared file", () => {
    const out = buildRecents(
      [
        { savedAt: 100, files: [{ name: "dup", localPath: "file:///d", size: 1 }] },
        { savedAt: 900, files: [{ name: "dup", localPath: "file:///d", size: 1 }] },
      ],
      { limit: 10 },
    );
    expect(out).toHaveLength(1);
    expect(first(out).modifiedAt).toBe(900);
  });

  it("respects the limit and handles empty / malformed history", () => {
    expect(buildRecents(history, { limit: 1 })).toHaveLength(1);
    expect(buildRecents(history, { limit: 0 })).toHaveLength(0);
    expect(buildRecents([], { limit: 10 })).toEqual([]);
    expect(
      buildRecents([{ savedAt: 1, files: [{ name: "x", localPath: "" }] }], {
        limit: 10,
      }),
    ).toEqual([]);
  });
});

describe("buildDownloads", () => {
  it("maps a SAF listing newest-first and tags the source", () => {
    const out = buildDownloads(
      [
        { uri: "content://a", name: "a.pdf", size: 10, modificationTime: 100 },
        { uri: "content://b", name: "b.pdf", size: 20, modificationTime: 900 },
      ],
      { limit: 10 },
    );
    expect(out.map((e) => e.name)).toEqual(["b.pdf", "a.pdf"]);
    expect(out.every((e) => e.source === "downloads")).toBe(true);
  });

  it("normalizes null size / modificationTime to undefined", () => {
    const out = buildDownloads(
      [{ uri: "content://a", name: "a.pdf", size: null, modificationTime: null }],
      { limit: 10 },
    );
    expect(first(out).size).toBeUndefined();
    expect(first(out).modifiedAt).toBeUndefined();
  });

  it("falls back to the uri tail when a name is missing", () => {
    const out = buildDownloads(
      [{ uri: "content://tree/doc.pdf", name: "" }],
      { limit: 10 },
    );
    expect(first(out).name).toBe("doc.pdf");
  });
});

describe("materialization routing", () => {
  it("flags SAF content uris and leaves cache file uris alone", () => {
    expect(needsMaterialization("content://tree/x")).toBe(true);
    expect(needsMaterialization("file:///cache/x")).toBe(false);
    expect(needsMaterialization("")).toBe(false);
  });

  it("splits a mixed selection into copy / pass-through", () => {
    const { direct, needsCopy } = partitionForMaterialization([
      entry({ uri: "file:///recent.txt" }),
      entry({ uri: "content://dl/doc.pdf", source: "downloads" }),
    ]);
    expect(direct.map((e) => e.uri)).toEqual(["file:///recent.txt"]);
    expect(needsCopy.map((e) => e.uri)).toEqual(["content://dl/doc.pdf"]);
  });
});

describe("selection → share mapping", () => {
  const list = [
    entry({ uri: "file:///a", name: "a", size: 100 }),
    entry({ uri: "content://b", name: "b", size: 250, source: "downloads" }),
    entry({ uri: "file:///c", name: "c", size: 1 }),
  ];

  it("returns checked rows in list order", () => {
    const picked = selectedEntries(list, new Set(["file:///c", "file:///a"]));
    expect(picked.map((e) => e.name)).toEqual(["a", "c"]);
  });

  it("summarizes count and bytes for the send button", () => {
    expect(selectionSummary(list, new Set(["file:///a", "content://b"]))).toEqual({
      count: 2,
      bytes: 350,
    });
    expect(selectionSummary(list, new Set())).toEqual({ count: 0, bytes: 0 });
  });

  it("tolerates entries with no known size", () => {
    const sized = [entry({ uri: "u", size: undefined })];
    expect(selectionSummary(sized, new Set(["u"]))).toEqual({ count: 1, bytes: 0 });
  });

  it("maps to the same PickedFile shape the OS picker produces", () => {
    expect(toPickedFiles([first(list)])).toEqual([
      { name: "a", size: 100, uri: "file:///a" },
    ]);
  });

  it("swaps SAF uris for their materialized cache paths", () => {
    const out = toPickedFiles(list, { "content://b": "file:///cache/b" });
    expect(out.map((f) => f.uri)).toEqual([
      "file:///a",
      "file:///cache/b",
      "file:///c",
    ]);
  });

  it("drops rows that resolve to no uri at all", () => {
    expect(toPickedFiles([entry({ uri: "" })])).toEqual([]);
  });
});

// ---------------------------------------------------------- thumbnails

describe("thumbnailFor", () => {
  it("asks for a real thumbnail only for image types", () => {
    for (const n of ["a.jpg", "b.JPEG", "c.png", "d.gif", "e.webp", "f.heic"]) {
      expect(thumbnailFor(n)).toEqual({ kind: "image" });
    }
  });

  it("falls back to a type icon for everything else — no generation", () => {
    // Explicitly including video/pdf: thumbnail *generation* for these is
    // out of scope, so they must resolve to icons, not images.
    expect(thumbnailFor("clip.mp4")).toEqual({
      kind: "icon",
      icon: "videocam-outline",
    });
    expect(thumbnailFor("paper.pdf")).toEqual({
      kind: "icon",
      icon: "document-outline",
    });
    expect(thumbnailFor("script.py")).toEqual({
      kind: "icon",
      icon: "document-text-outline",
    });
    expect(thumbnailFor("bundle.zip")).toEqual({
      kind: "icon",
      icon: "archive-outline",
    });
    expect(thumbnailFor("song.mp3")).toEqual({
      kind: "icon",
      icon: "musical-notes-outline",
    });
  });

  it("gives an icon to extensionless files rather than guessing image", () => {
    expect(thumbnailFor("README")).toEqual({
      kind: "icon",
      icon: "document-outline",
    });
  });
});

describe("typeBadge", () => {
  it("uppercases and clips the extension", () => {
    expect(typeBadge("paper.pdf")).toBe("PDF");
    expect(typeBadge("script.py")).toBe("PY");
    expect(typeBadge("archive.tar.gz")).toBe("GZ");
    expect(typeBadge("photo.jpeg")).toBe("JPEG");
  });

  it("clips long extensions to the budget", () => {
    expect(typeBadge("thing.markdown", 4)).toBe("MARK");
  });

  it("returns empty for names with no usable extension", () => {
    expect(typeBadge("README")).toBe("");
    expect(typeBadge(".gitignore")).toBe("");
    expect(typeBadge("")).toBe("");
  });
});

describe("toDisplayUri", () => {
  it("adds a scheme to the bare paths share history stores", () => {
    expect(toDisplayUri("/data/user/0/cache/a.jpg")).toBe(
      "file:///data/user/0/cache/a.jpg",
    );
  });

  it("leaves scheme-carrying uris untouched", () => {
    expect(toDisplayUri("file:///cache/a.jpg")).toBe("file:///cache/a.jpg");
    expect(toDisplayUri("content://tree/a.jpg")).toBe("content://tree/a.jpg");
  });

  it("passes empty through rather than producing a bogus file://", () => {
    expect(toDisplayUri("")).toBe("");
  });
});

describe("pageEntries", () => {
  const list = [1, 2, 3, 4, 5];

  it("reveals a page and reports what's left", () => {
    expect(pageEntries(list, 2)).toEqual({ visible: [1, 2], remaining: 3 });
  });

  it("reports nothing remaining once the page covers the list", () => {
    expect(pageEntries(list, 5)).toEqual({ visible: list, remaining: 0 });
    expect(pageEntries(list, 99)).toEqual({ visible: list, remaining: 0 });
  });

  it("handles zero / negative page sizes and empty lists", () => {
    expect(pageEntries(list, 0)).toEqual({ visible: [], remaining: 5 });
    expect(pageEntries(list, -3)).toEqual({ visible: [], remaining: 5 });
    expect(pageEntries([], 10)).toEqual({ visible: [], remaining: 0 });
  });
});

describe("multi-folder merge", () => {
  const downloads = buildDownloads(
    [
      { uri: "content://dl/a.pdf", name: "a.pdf", modificationTime: 100 },
      { uri: "content://dl/c.zip", name: "c.zip", modificationTime: 900 },
    ],
    { limit: 100, folderLabel: "Download" },
  );
  const trip = buildDownloads(
    [
      { uri: "content://tr/b.jpg", name: "b.jpg", modificationTime: 500 },
      { uri: "content://tr/d.mp4", name: "d.mp4", modificationTime: 50 },
    ],
    { limit: 100, folderLabel: "Trip" },
  );

  it("tags each row with the folder it came from", () => {
    expect(downloads.every((e) => e.folderLabel === "Download")).toBe(true);
    expect(trip.every((e) => e.folderLabel === "Trip")).toBe(true);
  });

  it("omits the tag entirely when no label is supplied", () => {
    const untagged = buildDownloads(
      [{ uri: "content://x/f", name: "f", modificationTime: 1 }],
      { limit: 10 },
    );
    expect(first(untagged).folderLabel).toBeUndefined();
  });

  it("interleaves folders by date rather than concatenating blocks", () => {
    const merged = mergeFolderListings([downloads, trip], { limit: 100 });
    expect(merged.map((e) => e.name)).toEqual([
      "c.zip", // 900  Download
      "b.jpg", // 500  Trip
      "a.pdf", // 100  Download
      "d.mp4", // 50   Trip
    ]);
  });

  it("keeps the origin label intact through the merge", () => {
    const merged = mergeFolderListings([downloads, trip], { limit: 100 });
    expect(merged.map((e) => e.folderLabel)).toEqual([
      "Download",
      "Trip",
      "Download",
      "Trip",
    ]);
  });

  it("survives a folder that listed nothing — one dead folder isn't fatal", () => {
    const merged = mergeFolderListings([downloads, [], trip], { limit: 100 });
    expect(merged).toHaveLength(4);
    expect(mergeFolderListings([[], []], { limit: 100 })).toEqual([]);
    expect(mergeFolderListings([], { limit: 100 })).toEqual([]);
  });

  it("dedupes a file reachable through two overlapping grants", () => {
    // Granting both /Documents and /Documents/Work surfaces the same uri
    // twice; the row must appear once.
    const merged = mergeFolderListings([downloads, downloads], { limit: 100 });
    expect(merged).toHaveLength(2);
  });

  it("applies the cap across the union, not per folder", () => {
    expect(mergeFolderListings([downloads, trip], { limit: 3 })).toHaveLength(3);
  });
});

describe("shouldShowFolderLabels", () => {
  it("hides origin labels until more than one folder is in play", () => {
    expect(shouldShowFolderLabels(0)).toBe(false);
    expect(shouldShowFolderLabels(1)).toBe(false);
    expect(shouldShowFolderLabels(2)).toBe(true);
    expect(shouldShowFolderLabels(5)).toBe(true);
  });
});

describe("folderDisplayName", () => {
  const TREE = "content://com.android.externalstorage.documents/tree";

  it("names the common Downloads grant", () => {
    expect(folderDisplayName(`${TREE}/primary%3ADownload`)).toBe("Download");
  });

  it("names a nested folder by its leaf, not the whole path", () => {
    expect(folderDisplayName(`${TREE}/primary%3ADocuments%2FWork`)).toBe("Work");
  });

  it("strips a non-primary volume prefix (SD card)", () => {
    expect(folderDisplayName(`${TREE}/1234-5678%3AMyFolder`)).toBe("MyFolder");
  });

  it("ignores a trailing /document/ segment some providers append", () => {
    expect(
      folderDisplayName(`${TREE}/primary%3ADownload/document/primary%3ADownload`),
    ).toBe("Download");
  });

  it("handles spaces and unicode in folder names", () => {
    expect(folderDisplayName(`${TREE}/primary%3AMy%20Files`)).toBe("My Files");
  });

  it("returns empty rather than leaking a uri when nothing is derivable", () => {
    expect(folderDisplayName("")).toBe("");
    expect(folderDisplayName(`${TREE}/`)).toBe("");
  });

  it("survives a malformed percent-encoding instead of throwing", () => {
    // decodeURIComponent throws on a lone "%" — the caller must still get
    // a string, since this only feeds a label.
    expect(typeof folderDisplayName(`${TREE}/primary%3ABad%ZZ`)).toBe("string");
  });
});

describe("fuller recents (5F caps)", () => {
  const manyShares = Array.from({ length: 80 }, (_, i) => ({
    savedAt: i,
    files: [{ name: `f${i}.txt`, localPath: `/cache/f${i}.txt`, size: 1 }],
  }));

  it("returns up to the raised recent-shares cap, newest first", () => {
    const out = buildRecents(manyShares, { limit: 60 });
    expect(out).toHaveLength(60);
    expect(first(out).name).toBe("f79.txt");
  });

  it("orders the Downloads listing purely by modified time", () => {
    const listing = [
      { uri: "content://a", name: "a", modificationTime: 5 },
      { uri: "content://b", name: "b", modificationTime: 50 },
      { uri: "content://c", name: "c", modificationTime: 500 },
    ];
    expect(
      buildDownloads(listing, { limit: 500 }).map((e) => e.name),
    ).toEqual(["c", "b", "a"]);
  });

  it("keeps the whole listing under the raised cap", () => {
    const listing = Array.from({ length: 300 }, (_, i) => ({
      uri: `content://${i}`,
      name: `f${i}`,
      modificationTime: i,
    }));
    expect(buildDownloads(listing, { limit: 500 })).toHaveLength(300);
  });
});
