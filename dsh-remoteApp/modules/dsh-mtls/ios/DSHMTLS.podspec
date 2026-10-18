Pod::Spec.new do |s|
  s.name           = 'DSHMTLS'
  s.version        = '0.1.0'
  s.summary        = 'DSH Remote native mTLS WebView + device identity (POC skeleton)'
  s.description    = <<-DESC
    POC skeleton for DSH Remote:
      - WKWebView subclass answering TLS client-certificate challenges with a
        Keychain SecIdentity (mTLS to the host plugin over the relay tunnel).
      - Keychain helpers to import / find / delete the device identity.
    Device key generation + CSR is a next-milestone item.
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
