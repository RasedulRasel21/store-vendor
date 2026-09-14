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
        <h1 className={styles.heading}>StoreVendor ‑ Marketplace</h1>
        <p className={styles.text}>
          Turn your Shopify store into a multi-vendor marketplace.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Vendor management</strong>. Invite vendors, review
            applications, and approve or suspend sellers from your Shopify
            admin.
          </li>
          <li>
            <strong>Vendor portal</strong>. Vendors manage their own products,
            orders, and earnings in a dedicated portal.
          </li>
          <li>
            <strong>Commissions and payouts</strong>. Split every order by
            vendor and track what each vendor has earned.
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
