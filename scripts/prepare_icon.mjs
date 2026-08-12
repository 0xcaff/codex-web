#!/usr/bin/env node

import sharp from "sharp";

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  throw new Error("usage: prepare_icon.mjs <source> <target>");
}

const iconSize = 512;
const contentSize = Math.floor(iconSize * 0.75);
const paddingBefore = Math.floor((iconSize - contentSize) / 2);
const paddingAfter = iconSize - contentSize - paddingBefore;

await sharp(source)
  .resize(contentSize, contentSize, { fit: "inside" })
  .flatten({ background: "white" })
  .extend({
    top: paddingBefore,
    bottom: paddingAfter,
    left: paddingBefore,
    right: paddingAfter,
    background: "white",
  })
  .removeAlpha()
  .png()
  .toFile(target);
