// Put a shop on any plan by hand, without a Shopify charge.
//
//   node scripts/set-plan.mjs                      list every shop and its plan
//   node scripts/set-plan.mjs foo.myshopify.com pro    pin foo to Pro
//   node scripts/set-plan.mjs foo.myshopify.com clear  hand control back to billing
//
// Why an override column rather than editing `planName` directly: `planName` is
// recomputed from Shopify billing on every admin page load and by the
// app_subscriptions/update webhook, so a hand edit is reverted within seconds.
// `planOverride` is never written by that sync, so it sticks.
import { PrismaClient } from "@prisma/client";

try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on ambient environment variables.
}

const PLANS = ["free", "growth", "pro", "custom"];

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
});

const [domain, plan] = process.argv.slice(2);

function usage() {
  console.log("Usage:");
  console.log("  node scripts/set-plan.mjs                          list shops");
  console.log(`  node scripts/set-plan.mjs <domain> <${PLANS.join("|")}>   pin a plan`);
  console.log("  node scripts/set-plan.mjs <domain> clear           remove the override");
}

try {
  if (!domain) {
    const shops = await prisma.shop.findMany({
      select: { domain: true, planName: true, planOverride: true, installedAt: true },
      orderBy: { installedAt: "asc" },
    });
    if (!shops.length) {
      console.log("No shops installed yet.");
    } else {
      const pad = Math.max(...shops.map((s) => s.domain.length));
      console.log("DOMAIN".padEnd(pad) + "  BILLING   OVERRIDE  EFFECTIVE");
      for (const s of shops) {
        const effective = s.planOverride ?? s.planName;
        console.log(
          s.domain.padEnd(pad) +
            "  " +
            String(s.planName).padEnd(9) +
            String(s.planOverride ?? "-").padEnd(9) +
            " " +
            effective,
        );
      }
    }
    console.log("");
    usage();
    process.exit(0);
  }

  const shop = await prisma.shop.findUnique({ where: { domain } });
  if (!shop) {
    console.error(`x No shop with domain "${domain}". Run with no arguments to list them.`);
    process.exit(1);
  }

  if (plan === "clear") {
    await prisma.shop.update({ where: { id: shop.id }, data: { planOverride: null } });
    console.log(`Cleared the override on ${domain}. Billing now decides the plan.`);
    console.log(`It will resolve on the merchant's next admin visit (currently "${shop.planName}").`);
    process.exit(0);
  }

  if (!PLANS.includes(plan)) {
    console.error(`x "${plan ?? ""}" is not a plan. Use one of: ${PLANS.join(", ")}, or "clear".`);
    usage();
    process.exit(1);
  }

  // planName is set too so storefront gates (the App Proxy has no billing
  // context and reads planName) take effect immediately rather than after the
  // next admin visit.
  await prisma.shop.update({
    where: { id: shop.id },
    data: { planOverride: plan, planName: plan },
  });
  console.log(`${domain} is now on "${plan}" with no Shopify charge.`);
  console.log('Run with "clear" to hand control back to billing.');
} catch (e) {
  console.error("x Failed:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
