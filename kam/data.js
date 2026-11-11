// Mock seller data.
//
// GIVEN   = taken directly from the assignment brief.
// ASSUMED = added by me so the agent can go one level deeper than the headline
//           numbers. Every assumed figure is constructed to add up exactly to
//           the given figures (see scripts/smoke.js, which checks this).

// ASSUMED: seller identity.
export const seller = {
  id: 'SD-48213',
  name: 'Ramesh Gupta',
  store: 'Gupta Home Essentials',
  category: 'Home & Kitchen',
  city: 'Jaipur',
  activeListings: 64,
};

// GIVEN: the five metrics from the brief.
export const metrics = {
  lastMonth: { sales: 200000, orders: 400, cancellationRate: 8, asp: 500, oosProducts: 5 },
  thisMonth: { sales: 135000, orders: 270, cancellationRate: 14, asp: 500, oosProducts: 18 },
};

// ASSUMED: order split by product group.
// 5 products were already out of stock last month (slow movers, no orders).
// 13 more ran out this month, 4 of them bestsellers.
// Totals: last month 184 + 30 + 0 + 186 = 400, this month 68 + 12 + 0 + 190 = 270.
export const bestsellersOutOfStock = [
  { sku: 'HK-1042', name: 'Steel Lunch Box, 3 tier', ordersLastMonth: 62, ordersThisMonth: 21, daysOutOfStock: 19 },
  { sku: 'HK-2210', name: 'Non-stick Tawa, 28 cm', ordersLastMonth: 48, ordersThisMonth: 17, daysOutOfStock: 17 },
  { sku: 'HL-3305', name: 'Cotton Double Bedsheet', ordersLastMonth: 41, ordersThisMonth: 16, daysOutOfStock: 14 },
  { sku: 'HK-1877', name: 'Insulated Water Bottle, 1 litre', ordersLastMonth: 33, ordersThisMonth: 14, daysOutOfStock: 12 },
];

export const otherNewlyOutOfStock = { count: 9, ordersLastMonth: 30, ordersThisMonth: 12 };
export const alreadyOutOfStockLastMonth = { count: 5, ordersLastMonth: 0, ordersThisMonth: 0 };
export const inStockProducts = { count: 46, ordersLastMonth: 186, ordersThisMonth: 190 };

// ASSUMED: cancellation reasons, in orders.
// Last month 8% of 400 = 32. This month 14% of 270 = 37.8, rounded to 38.
export const cancellations = {
  lastMonth: { sellerNoStock: 6, customerCancelled: 17, deliveryFailed: 9 },
  thisMonth: { sellerNoStock: 21, customerCancelled: 11, deliveryFailed: 6 },
};
