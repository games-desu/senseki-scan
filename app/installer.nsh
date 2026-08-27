; SENSEKI SCAN — NSIS カスタム
; アンインストール時にユーザー辞書（教えた認識データ）を消すかどうかを本人に選ばせる。
; electron-builder の deleteAppDataOnUninstall はワンクリック型専用で、
; 本アプリのアシスト型(oneClick:false)では効かないため、ここで自前実装する。
; ※アップデート時（isUpdated）は何も聞かず必ず残す。

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "ユーザーデータ（教えた認識辞書など）も削除しますか？$\r$\n$\r$\n「いいえ」を選ぶとアプリ本体だけを削除し、辞書は次回インストール時にそのまま引き継がれます。" \
      IDYES deleteUserData IDNO keepUserData
    deleteUserData:
      RMDir /r "$APPDATA\SENSEKI SCAN"
    keepUserData:
  ${endIf}
!macroend
