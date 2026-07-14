/**
 * Public surface of the transactional email template layer. PYZ-273 (Better
 * Auth wiring) and PYZ-153 (invite email) import the render functions and their
 * param types from `@/lib/email/templates`.
 */
export {
  type RenderedEmail,
  type VerificationParams,
  type PasswordResetParams,
  type EmailChangeParams,
  type EmailChangeApprovalParams,
  type PasswordChangedParams,
  type NewSignInParams,
  type DeleteAccountParams,
  verificationEmail,
  passwordResetEmail,
  emailChangeEmail,
  emailChangeApprovalEmail,
  passwordChangedEmail,
  newSignInEmail,
  deleteAccountEmail,
} from "./templates";
