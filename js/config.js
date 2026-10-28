/** App-level configuration. Values here are public (a web OAuth client ID is not a secret). */
export const config = {
  /** Google OAuth 2.0 Web client ID from console.cloud.google.com. Leave '' to hide the Google Drive backup feature. */
  googleClientId: '989162704178-6kpln08rc5ha3mqavovietjkb8k4cpq6.apps.googleusercontent.com',
  /** USDA FoodData Central API key shared by everyone using this deployment. It is a free key with a
   *  1,000 requests/hour limit; the owner can regenerate it at https://fdc.nal.usda.gov/api-key-signup.
   *  A user's own key in Settings overrides it. Leave '' to disable USDA unless a user adds a key. */
  usdaApiKey: 'dDGbJqbjcjCJRJGFdrjzN7jFBNcLTJJmHwgmRNFT'
};
