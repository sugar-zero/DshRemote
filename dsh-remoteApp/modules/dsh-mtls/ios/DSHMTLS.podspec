Pod::Spec.new do |s|
  s.name           = 'DSHMTLS'
  s.version        = '0.2.0'
  s.summary        = 'DSH Remote group-service device key + session cookie (P-256)'
  s.description    = <<-DESC
    Native helpers for DSH Remote (group service / token auth):
      - P-256 device key generation in the Secure Enclave (software Keychain fallback).
      - ECDSA-SHA256 challenge signing for the relay edge auth flow.
      - `__Host-` session cookie injection into the shared WKWebView cookie store.
      - WebView cache cleanup for the settings screen.
      - iOS bottom screen-edge gesture deferral (page widgets can be dragged from the very bottom).
    classic/mTLS client-certificate support has been removed from the app.
  DESC
  s.author         = ''
  s.homepage       = 'https://example.invalid/dsh-remote'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
