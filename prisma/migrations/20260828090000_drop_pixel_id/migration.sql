-- The Web Pixel extension was removed: conversion is measured as far as the
-- storefront can see it (add-to-cart), which needs no pixel and no write scopes.
ALTER TABLE "Shop" DROP COLUMN IF EXISTS "pixelId";
