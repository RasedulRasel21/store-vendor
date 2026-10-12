import { redirect } from "react-router";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  // Opened from the Shopify admin: continue into the embedded app.
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>StoreVendor: Vendor Manager</h1>
        <p className={styles.text}>
          Stock your shop with products from suppliers you choose, and keep
          control of what goes on sale.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>You decide what sells</strong>. Nothing a supplier submits
            reaches your storefront until you have seen it and approved it.
          </li>
          <li>
            <strong>Suppliers do their own paperwork</strong>. They add their
            products, follow the orders they supply and see what they have
            earned, without touching your admin.
          </li>
          <li>
            <strong>Commission worked out for you</strong>. Every order is
            split by supplier, reversed on a refund, and settled to you first.
          </li>
        </ul>
        <p className={styles.note}>
          Install StoreVendor from the Shopify App Store, then open it from your
          Shopify admin.
        </p>
      </div>
    </div>
  );
}
