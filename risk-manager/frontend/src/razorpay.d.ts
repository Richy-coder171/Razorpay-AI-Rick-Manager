/** Razorpay checkout.js typings (loaded from https://checkout.razorpay.com/v1/checkout.js). */

interface RazorpayCheckoutResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayOptions {
  key: string;
  amount: number; // paise
  currency: string;
  order_id: string;
  name: string;
  description?: string;
  handler: (response: RazorpayCheckoutResponse) => void;
  theme?: { color: string };
}

interface RazorpayInstance {
  open(): void;
  on(event: string, cb: (e: { error?: { description?: string }; description?: string }) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

export {};
