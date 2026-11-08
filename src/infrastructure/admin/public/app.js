const translations = Object.freeze({
  ar: Object.freeze({
    'app.title': 'إدارة البصمة',
    'app.subtitle': 'واجهة بسيطة للحضور والربط',
    'connection.connecting': 'جاري الاتصال…',
    'connection.connected': 'متصل',
    'connection.disconnected': 'غير متصل',
    'actions.refresh': 'تحديث',
    'actions.save': 'حفظ',
    'actions.cancel': 'إلغاء',
    'actions.close': 'إغلاق',
    'actions.map': 'ربط',
    'actions.busy': 'جارٍ التنفيذ…',
    'actions.details': 'تفاصيل',
    'language.switchLabel': 'Switch to English',
    'language.switchText': 'English',
    'nav.aria': 'أقسام النظام',
    'nav.home': 'الرئيسية',
    'nav.unmapped': 'يحتاج ربط',
    'nav.events': 'الحركات',
    'nav.reports': 'التقارير',
    'nav.issues': 'المراجعة',
    'nav.people': 'الأشخاص',
    'nav.devices': 'الأجهزة',
    'home.attention.title': 'يحتاج انتباهك',
    'home.attention.subtitle': 'نُظهر فقط الأشياء التي تتطلب إجراء.',
    'home.events.title': 'آخر الحركات النهائية',
    'home.events.subtitle': 'الحركات الجاهزة للاستخدام لاحقًا.',
    'dashboard.people': 'الأشخاص',
    'dashboard.peopleHint': 'مسجلون ونشطون',
    'dashboard.devices': 'الأجهزة',
    'dashboard.devicesActive': 'الأجهزة النشطة',
    'dashboard.devicesOfTotal': '{active} من {total} جهاز',
    'dashboard.unmapped': 'يحتاج ربط',
    'dashboard.needsAction': 'يحتاج إجراء منك',
    'dashboard.nothingPending': 'لا يوجد شيء معلق',
    'dashboard.issues': 'مشاكل مفتوحة',
    'dashboard.reviewWhenNeeded': 'راجعها عند الحاجة',
    'dashboard.allGood': 'كل شيء سليم',
    'unmapped.title': 'مستخدمون يحتاجون ربط',
    'unmapped.subtitle': 'أدخل الاسم فقط عندما لا يستطيع النظام معرفة الشخص تلقائيًا.',
    'unmapped.none': 'لا يوجد مستخدم يحتاج ربط.',
    'unmapped.userNumber': 'مستخدم رقم {code}',
    'unmapped.deviceNumber': 'الرقم على الجهاز: {code} · {device}',
    'unmapped.needsMapping': 'يحتاج ربط',
    'unmapped.mapTo': 'ربط بـ {name}',
    'unmapped.sameCodeFound': 'وجدنا شخصًا بنفس الرقم {code}.',
    'unmapped.personNamePlaceholder': 'اسم الشخص',
    'unmapped.personNameAria': 'اسم الشخص للمستخدم {code}',
    'unmapped.addAndMap': 'إضافة وربط',
    'unmapped.inactiveSameCode': 'يوجد شخص بنفس الرقم لكنه غير نشط؛ اختر شخصًا آخر.',
    'unmapped.mapExisting': 'ربط بشخص موجود',
    'attention.unmappedCount': '{count} مستخدم يحتاج ربط',
    'attention.unmappedHint': 'يمكنك إكمال الربط من شاشة «يحتاج ربط».',
    'attention.openMapping': 'فتح شاشة الربط',
    'attention.none': 'لا يوجد شيء يحتاج تدخلًا الآن.',
    'events.title': 'الحركات النهائية',
    'events.subtitle': 'سجل الحركات المعتمدة داخل نظام البصمة مع فلاتر بسيطة.',
    'events.final': 'نهائي',
    'events.none': 'لا توجد حركات نهائية حتى الآن.',
    'events.noneTable': 'لا توجد حركات مطابقة للفلاتر.',
    'events.noName': 'بدون اسم',
    'events.exportExcel': 'تصدير Excel',
    'events.exportLimit': 'التصدير يدعم حتى 10,000 حركة في الملف الواحد. ضيّق الفترة إذا كانت النتائج أكبر.',
    'table.person': 'الشخص',
    'table.event': 'الحركة',
    'table.time': 'الوقت',
    'table.device': 'الجهاز',
    'table.verification': 'التحقق',
    'table.details': 'التفاصيل',
    'issues.title': 'المراجعة',
    'issues.subtitle': 'المشكلات التشغيلية داخل نظام البصمة، مع إمكانية مراجعة المفتوح والمحلول.',
    'issues.none': 'لا توجد حالات مطابقة للفلاتر.',
    'issues.open': 'مفتوحة',
    'issues.resolved': 'محلولة',
    'issues.openMapping': 'فتح الربط',
    'issues.unmappedHelp': 'اربط مستخدم الجهاز بالشخص الصحيح، وسيحاول النظام إكمال الحركة تلقائيًا.',
    'issues.mappingConflictHelp': 'راجع ربط المستخدم الحالي قبل إعادة معالجة الحركة.',
    'issues.unknownEventHelp': 'الجهاز أرسل نوع حركة غير معروف؛ راجع إعداد الحركة على الجهاز.',
    'issues.invalidTimeHelp': 'وقت الحركة غير صالح؛ راجع وقت الجهاز والمنطقة الزمنية.',
    'issues.inactivePersonHelp': 'الشخص غير نشط؛ راجع حالته أو الربط قبل إكمال الحركة.',
    'issues.finalizationErrorHelp': 'تعذر إكمال الحركة تلقائيًا. حدّث الصفحة، وإذا استمرت المشكلة فتحتاج مراجعة فنية.',
    'issues.autoFinalizationPendingHelp': 'تعذر إكمال المعالجة النهائية مؤقتًا. سيعيد النظام المحاولة تلقائيًا دون فقد الحركة.',
    'issues.genericHelp': 'هذه الحالة تحتاج مراجعة قبل اعتماد الحركة.',
    'issues.resolvedAt': 'تم الحل: {time}',
    'people.title': 'الأشخاص',
    'people.subtitle': 'الرقم هو رقم الشخص الموحد داخل نظام البصمة.',
    'people.add': 'إضافة شخص',
    'people.code': 'الرقم',
    'people.name': 'الاسم',
    'people.status': 'الحالة',
    'people.linkedDevices': 'الأجهزة المرتبطة',
    'people.active': 'نشط',
    'people.inactive': 'غير نشط',
    'people.none': 'لا يوجد أشخاص مطابقون للفلاتر.',
    'people.historicalAction': 'معالجة البصمات القديمة',
    'historical.title': 'معالجة البصمات القديمة',
    'historical.subtitle': 'إعادة إتاحة حركات قديمة لهذا الشخص بعد ربطه في البرنامج الرئيسي. لا يتم تغيير أو حذف الحركات الأصلية.',
    'historical.person': 'الشخص: {name} ({code})',
    'historical.rangeHint': 'اختر فترة لا تتجاوز 31 يومًا في كل مرة.',
    'historical.preview': 'فحص الحركات',
    'historical.previewCount': 'وجدنا {count} حركة نهائية قديمة في الفترة المحددة.',
    'historical.previewNone': 'لا توجد حركات نهائية قديمة لهذا الشخص في الفترة المحددة.',
    'historical.previewTimes': 'من {from} إلى {to}',
    'historical.warning': 'هذه العملية ستصدر مراجع جديدة للحركات المختارة حتى يستطيع البرنامج الرئيسي قراءتها بعد الربط. الحركات الأصلية تبقى كما هي.',
    'historical.confirmLabel': 'أؤكد أنني أريد إعادة معالجة هذه الفترة يدويًا.',
    'historical.reprocess': 'إعادة معالجة الحركات',
    'historical.success': 'تمت إعادة إتاحة {count} حركة قديمة للبرنامج الرئيسي.',
    'historical.zeroSuccess': 'لا توجد حركات لإعادة المعالجة في هذه الفترة.',
    'historical.needsPreview': 'افحص الفترة أولًا قبل إعادة المعالجة.',
    'devices.title': 'الأجهزة',
    'devices.subtitle': 'حالة أجهزة البصمة فقط، بدون إعدادات تقنية غير ضرورية.',
    'devices.status': 'الحالة',
    'devices.biometricDevice': 'جهاز بصمة',
    'devices.available': 'متاح',
    'devices.unavailable': 'غير متاح',
    'devices.liveMode': 'وضع مباشر',
    'devices.maintenanceMode': 'وضع صيانة',
    'devices.unknownMode': 'وضع غير معروف',
    'devices.testMode': 'وضع اختبار',
    'devices.lastSeen': 'آخر اتصال: {time}',
    'devices.lastEvent': 'آخر حركة: {time}',
    'devices.unknown': 'غير معروف',
    'devices.none': 'لا توجد أجهزة مطابقة للفلاتر.',
    'mapping.title': 'ربط بشخص موجود',
    'mapping.selectPerson': 'اختر الشخص',
    'mapping.dialogHint': 'مستخدم الجهاز رقم {code}',
    'mapping.noActivePerson': 'لا يوجد شخص نشط للربط.',
    'filters.search': 'بحث',
    'filters.person': 'الشخص',
    'filters.device': 'الجهاز',
    'filters.period': 'الفترة',
    'filters.eventType': 'نوع الحركة',
    'filters.verification': 'طريقة التحقق',
    'filters.issueType': 'نوع المشكلة',
    'filters.mappingStatus': 'حالة الربط',
    'filters.mode': 'الوضع',
    'filters.vendor': 'المورّد',
    'filters.from': 'من',
    'filters.to': 'إلى',
    'filters.more': 'المزيد',
    'filters.apply': 'تطبيق',
    'filters.clear': 'مسح',
    'filters.allDevices': 'كل الأجهزة',
    'filters.allEvents': 'كل الحركات',
    'filters.allVerification': 'كل طرق التحقق',
    'filters.allStatuses': 'كل الحالات',
    'filters.allIssueTypes': 'كل الأنواع',
    'filters.allMappingStates': 'كل حالات الربط',
    'filters.allModes': 'كل الأوضاع',
    'filters.allVendors': 'كل الموردين',
    'filters.mapped': 'مربوط',
    'filters.unmapped': 'بدون جهاز مرتبط',
    'filters.searchPersonOrCodePlaceholder': 'الاسم أو الرقم',
    'filters.searchDevicePlaceholder': 'الاسم أو الموديل أو الرقم التسلسلي',
    'period.today': 'اليوم',
    'period.yesterday': 'أمس',
    'period.last7': 'آخر 7 أيام',
    'period.month': 'هذا الشهر',
    'period.all': 'كل الفترات',
    'period.custom': 'فترة مخصصة',
    'pagination.total': '{total} نتيجة',
    'pagination.page': 'صفحة {page} من {pages}',
    'pagination.previous': 'السابق',
    'pagination.next': 'التالي',
    'reports.title': 'تقارير نظام البصمة',
    'reports.subtitle': 'تقارير تشغيلية للبصمة فقط، دون تكرار تقارير الدوام والرواتب في البرنامج الرئيسي.',
    'reports.update': 'تحديث التقارير',
    'reports.health.title': 'سلامة النظام',
    'reports.health.subtitle': 'ملخص تشغيلي للحركات والمشكلات داخل نظام البصمة.',
    'reports.health.note': 'الحركات المستلمة هنا هي الحركات القانونية بعد إزالة التكرار. قد تتضمن بيانات اختبار تاريخية أقدم من تفعيل الإنهاء التلقائي، لذلك لا نعرض نسبة اكتمال قد تكون مضللة.',
    'reports.health.received': 'حركات مستلمة',
    'reports.health.final': 'حركات نهائية',
        'reports.health.issuesInPeriod': 'مشكلات فعلية ظهرت',
    'reports.health.openNow': 'مشكلات مفتوحة الآن',
    'reports.health.unmappedNow': 'يحتاج ربط الآن',
    'reports.health.noRate': 'لا توجد حركات في الفترة',
    'reports.devices.title': 'الأجهزة والاتصال',
    'reports.devices.subtitle': 'نشاط كل جهاز ومشكلاته التشغيلية خلال الفترة.',
    'reports.devices.events': 'الحركات',
    'reports.devices.openIssues': 'مشاكل مفتوحة',
    'reports.devices.unmapped': 'غير مربوط',
    'reports.devices.lastSeen': 'آخر اتصال',
    'reports.mapping.title': 'الربط والجاهزية',
    'reports.mapping.subtitle': 'هل الأشخاص ومستخدمو الأجهزة مربوطون وجاهزون؟',
    'reports.mapping.people': 'الأشخاص',
    'reports.mapping.activePeople': 'الأشخاص النشطون',
    'reports.mapping.deviceUsers': 'مستخدمو الأجهزة',
    'reports.mapping.activeMappings': 'روابط نشطة',
    'reports.mapping.unmappedUsers': 'مستخدمون يحتاجون ربط',
    'reports.mapping.peopleWithoutDevices': 'أشخاص بدون جهاز',
    'reports.mapping.multiDevice': 'أشخاص على عدة أجهزة',
    'reports.mapping.inactiveMappings': 'روابط غير نشطة',
    'reports.issues.title': 'المشكلات والمعالجة',
    'reports.issues.subtitle': 'المشكلات التشغيلية التي ظهرت داخل نظام البصمة، المفتوحة والمحلولة.',
    'reports.issues.problem': 'المشكلة',
    'reports.issues.total': 'ظهرت في الفترة',
    'reports.issues.resolved': 'محلولة',
    'reports.issues.open': 'ما زالت مفتوحة',
    'reports.issues.lastSeen': 'آخر ظهور',
    'reports.issues.none': 'لم تظهر مشكلات في الفترة المختارة.',
    'eventDetails.title': 'تفاصيل الحركة',
    'eventDetails.subtitle': 'بيانات آمنة لإثبات الحركة داخل نظام البصمة.',
    'eventDetails.reference': 'معرف الحركة',
    'eventDetails.personCode': 'رقم الشخص',
    'eventDetails.personName': 'اسم الشخص',
    'eventDetails.event': 'الحركة',
    'eventDetails.localTime': 'الوقت المحلي',
    'eventDetails.utcTime': 'الوقت UTC',
    'eventDetails.timezone': 'المنطقة الزمنية',
    'eventDetails.device': 'الجهاز',
    'eventDetails.deviceSerial': 'الرقم التسلسلي',
    'eventDetails.verification': 'طريقة التحقق',
    'eventDetails.version': 'نسخة المعالجة',
    'eventDetails.status': 'الحالة',
    'eventDetails.copyReference': 'نسخ معرف الحركة',
    'eventDetails.copied': 'تم نسخ معرف الحركة.',
    'success.refreshed': 'تم تحديث البيانات.',
    'success.personMapped': 'تم ربط المستخدم بالشخص.',
    'success.personMappedSelected': 'تم الربط بالشخص المحدد.',
    'success.personCreatedMapped': 'تمت إضافة الشخص وربطه بالجهاز.',
    'success.personCreated': 'تمت إضافة الشخص.',
    'success.reprocessed': '{message} وتمت معالجة {count} حركة معلقة تلقائيًا.',
    'validation.enterName': 'اكتب اسم الشخص أولًا.',
    'validation.customPeriod': 'اختر تاريخ البداية أو النهاية للفترة المخصصة.',
    'error.personCodeConflict': 'هذا الرقم مستخدم لشخص آخر.',
    'error.mappingConflict': 'مستخدم الجهاز مربوط بالفعل.',
    'error.personInactive': 'الشخص المحدد غير نشط.',
    'error.displayNameRequired': 'اسم الشخص مطلوب.',
    'error.personNotFound': 'الشخص غير موجود.',
    'error.deviceUserNotFound': 'مستخدم الجهاز غير موجود.',
    'error.historicalRange': 'اختر تاريخ البداية والنهاية بشكل صحيح، وبحد أقصى 31 يومًا.',
    'error.historicalLimit': 'الفترة تحتوي حركات كثيرة. اختر فترة أصغر ثم حاول مرة أخرى.',
    'error.historicalChanged': 'تغيرت الحركات منذ الفحص. افحص الفترة مرة أخرى ثم أعد المحاولة.',
    'error.historicalConfirmation': 'يجب تأكيد إعادة المعالجة أولًا.',
    'error.generic': 'تعذر تنفيذ العملية.',
    'issue.unmapped': 'حركة لمستخدم غير مربوط',
    'issue.mappingConflict': 'تعارض في الربط',
    'issue.unknownEvent': 'نوع حركة غير معروف',
    'issue.invalidTime': 'وقت حركة غير صالح',
    'issue.inactivePerson': 'حركة لشخص غير نشط',
    'issue.finalizationError': 'تعذر إنهاء حركة',
    'issue.autoFinalizationPending': 'المعالجة النهائية معلقة',
    'issue.needsReview': 'مشكلة تحتاج مراجعة',
    'issue.user': 'مستخدم {code}',
    'issue.unknownUser': 'مستخدم غير معروف',
    'event.checkIn': 'حضور',
    'event.checkOut': 'انصراف',
    'event.breakOut': 'بداية استراحة',
    'event.breakIn': 'عودة من الاستراحة',
    'event.overtimeIn': 'بداية وقت إضافي',
    'event.overtimeOut': 'نهاية وقت إضافي',
    'event.generic': 'حركة',
    'verification.fingerprint': 'بصمة إصبع',
    'verification.face': 'وجه',
    'verification.palm': 'كف',
    'verification.card': 'بطاقة',
    'verification.password': 'رمز تحقق',
    'verification.unknown': 'غير محدد',
    'device.fallback': 'جهاز {id}'
  }),
  en: Object.freeze({
    'app.title': 'Biometric Management',
    'app.subtitle': 'Simple attendance and identity mapping',
    'connection.connecting': 'Connecting…',
    'connection.connected': 'Connected',
    'connection.disconnected': 'Disconnected',
    'actions.refresh': 'Refresh',
    'actions.save': 'Save',
    'actions.cancel': 'Cancel',
    'actions.close': 'Close',
    'actions.map': 'Map',
    'actions.busy': 'Working…',
    'actions.details': 'Details',
    'language.switchLabel': 'التبديل إلى العربية',
    'language.switchText': 'العربية',
    'nav.aria': 'System sections',
    'nav.home': 'Home',
    'nav.unmapped': 'Needs Mapping',
    'nav.events': 'Events',
    'nav.reports': 'Reports',
    'nav.issues': 'Review',
    'nav.people': 'People',
    'nav.devices': 'Devices',
    'home.attention.title': 'Needs Your Attention',
    'home.attention.subtitle': 'Only items that need an action are shown here.',
    'home.events.title': 'Latest Final Events',
    'home.events.subtitle': 'Events ready for later use.',
    'dashboard.people': 'People',
    'dashboard.peopleHint': 'Registered and active',
    'dashboard.devices': 'Devices',
    'dashboard.devicesActive': 'Active devices',
    'dashboard.devicesOfTotal': '{active} of {total} devices',
    'dashboard.unmapped': 'Needs Mapping',
    'dashboard.needsAction': 'Action required',
    'dashboard.nothingPending': 'Nothing pending',
    'dashboard.issues': 'Open Issues',
    'dashboard.reviewWhenNeeded': 'Review when needed',
    'dashboard.allGood': 'Everything looks good',
    'unmapped.title': 'Users Needing Mapping',
    'unmapped.subtitle': 'Enter a name only when the system cannot safely identify the person.',
    'unmapped.none': 'No users need mapping.',
    'unmapped.userNumber': 'User {code}',
    'unmapped.deviceNumber': 'Device user: {code} · {device}',
    'unmapped.needsMapping': 'Needs Mapping',
    'unmapped.mapTo': 'Map to {name}',
    'unmapped.sameCodeFound': 'A person with code {code} already exists.',
    'unmapped.personNamePlaceholder': 'Person name',
    'unmapped.personNameAria': 'Person name for device user {code}',
    'unmapped.addAndMap': 'Add & Map',
    'unmapped.inactiveSameCode': 'A person with this code exists but is inactive; choose another person.',
    'unmapped.mapExisting': 'Map to Existing Person',
    'attention.unmappedCount': '{count} users need mapping',
    'attention.unmappedHint': 'Complete the mapping from the “Needs Mapping” screen.',
    'attention.openMapping': 'Open Mapping',
    'attention.none': 'Nothing needs your attention right now.',
    'events.title': 'Final Events',
    'events.subtitle': 'Finalized biometric events with simple operational filters.',
    'events.final': 'Final',
    'events.none': 'No final events yet.',
    'events.noneTable': 'No events match the selected filters.',
    'events.noName': 'No name',
    'events.exportExcel': 'Export Excel',
    'events.exportLimit': 'Exports support up to 10,000 events per file. Narrow the period for larger result sets.',
    'table.person': 'Person',
    'table.event': 'Event',
    'table.time': 'Time',
    'table.device': 'Device',
    'table.verification': 'Verification',
    'table.details': 'Details',
    'issues.title': 'Review',
    'issues.subtitle': 'Operational biometric issues, including open and resolved history.',
    'issues.none': 'No cases match the selected filters.',
    'issues.open': 'Open',
    'issues.resolved': 'Resolved',
    'issues.openMapping': 'Open Mapping',
    'issues.unmappedHelp': 'Map the device user to the correct person and the system will retry the event automatically.',
    'issues.mappingConflictHelp': 'Review the current user mapping before reprocessing the event.',
    'issues.unknownEventHelp': 'The device sent an unknown event type; review the event setting on the device.',
    'issues.invalidTimeHelp': 'The event time is invalid; review the device clock and timezone.',
    'issues.inactivePersonHelp': 'The person is inactive; review the person status or mapping before finalizing.',
    'issues.finalizationErrorHelp': 'The event could not be finalized automatically. Refresh first; if it persists, technical review is needed.',
    'issues.autoFinalizationPendingHelp': 'Finalization could not complete temporarily. The system will retry automatically without losing the event.',
    'issues.genericHelp': 'This case needs review before the event can be finalized.',
    'issues.resolvedAt': 'Resolved: {time}',
    'people.title': 'People',
    'people.subtitle': 'The code is the unified person number inside the biometric system.',
    'people.add': 'Add Person',
    'people.code': 'Code',
    'people.name': 'Name',
    'people.status': 'Status',
    'people.linkedDevices': 'Linked Devices',
    'people.active': 'Active',
    'people.inactive': 'Inactive',
    'people.none': 'No people match the selected filters.',
    'people.historicalAction': 'Reprocess Historical Events',
    'historical.title': 'Reprocess Historical Biometric Events',
    'historical.subtitle': 'Reissue older events for this person after linking them in the main application. Original events are never changed or deleted.',
    'historical.person': 'Person: {name} ({code})',
    'historical.rangeHint': 'Choose a period of up to 31 days per operation.',
    'historical.preview': 'Preview Events',
    'historical.previewCount': '{count} historical final event(s) were found in the selected period.',
    'historical.previewNone': 'No historical final events were found for this person in the selected period.',
    'historical.previewTimes': 'From {from} to {to}',
    'historical.warning': 'This will publish new event references for the selected history so the main application can read them after linking. Original events remain unchanged.',
    'historical.confirmLabel': 'I confirm that I want to manually reprocess this period.',
    'historical.reprocess': 'Reprocess Events',
    'historical.success': '{count} historical event(s) were reissued to the main application.',
    'historical.zeroSuccess': 'There are no events to reprocess in this period.',
    'historical.needsPreview': 'Preview the period before reprocessing.',
    'devices.title': 'Devices',
    'devices.subtitle': 'Biometric device status only. Unnecessary technical settings stay hidden.',
    'devices.status': 'Status',
    'devices.biometricDevice': 'Biometric Device',
    'devices.available': 'Available',
    'devices.unavailable': 'Unavailable',
    'devices.liveMode': 'Live Mode',
    'devices.maintenanceMode': 'Maintenance Mode',
    'devices.unknownMode': 'Unknown Mode',
    'devices.testMode': 'Test Mode',
    'devices.lastSeen': 'Last seen: {time}',
    'devices.lastEvent': 'Last event: {time}',
    'devices.unknown': 'Unknown',
    'devices.none': 'No devices match the selected filters.',
    'mapping.title': 'Map to Existing Person',
    'mapping.selectPerson': 'Select person',
    'mapping.dialogHint': 'Device user {code}',
    'mapping.noActivePerson': 'No active person is available for mapping.',
    'filters.search': 'Search',
    'filters.person': 'Person',
    'filters.device': 'Device',
    'filters.period': 'Period',
    'filters.eventType': 'Event type',
    'filters.verification': 'Verification',
    'filters.issueType': 'Issue type',
    'filters.mappingStatus': 'Mapping status',
    'filters.mode': 'Mode',
    'filters.vendor': 'Vendor',
    'filters.from': 'From',
    'filters.to': 'To',
    'filters.more': 'More',
    'filters.apply': 'Apply',
    'filters.clear': 'Clear',
    'filters.allDevices': 'All devices',
    'filters.allEvents': 'All events',
    'filters.allVerification': 'All verification methods',
    'filters.allStatuses': 'All statuses',
    'filters.allIssueTypes': 'All issue types',
    'filters.allMappingStates': 'All mapping states',
    'filters.allModes': 'All modes',
    'filters.allVendors': 'All vendors',
    'filters.mapped': 'Mapped',
    'filters.unmapped': 'No linked device',
    'filters.searchPersonOrCodePlaceholder': 'Name or code',
    'filters.searchDevicePlaceholder': 'Name, model, or serial number',
    'period.today': 'Today',
    'period.yesterday': 'Yesterday',
    'period.last7': 'Last 7 days',
    'period.month': 'This month',
    'period.all': 'All periods',
    'period.custom': 'Custom period',
    'pagination.total': '{total} results',
    'pagination.page': 'Page {page} of {pages}',
    'pagination.previous': 'Previous',
    'pagination.next': 'Next',
    'reports.title': 'Biometric System Reports',
    'reports.subtitle': 'Operational biometric reports only, without duplicating attendance or payroll reports in the main application.',
    'reports.update': 'Update Reports',
    'reports.health.title': 'System Health',
    'reports.health.subtitle': 'Operational summary of events and issues inside the biometric system.',
    'reports.health.note': 'Received events are canonical deduplicated events. Historical test data may predate automatic finalization, so a potentially misleading completion percentage is intentionally not shown.',
    'reports.health.received': 'Received events',
    'reports.health.final': 'Final events',
        'reports.health.issuesInPeriod': 'Actual issues appeared',
    'reports.health.openNow': 'Open issues now',
    'reports.health.unmappedNow': 'Needs mapping now',
    'reports.health.noRate': 'No events in this period',
    'reports.devices.title': 'Devices & Connectivity',
    'reports.devices.subtitle': 'Each device activity and operational issues during the selected period.',
    'reports.devices.events': 'Events',
    'reports.devices.openIssues': 'Open issues',
    'reports.devices.unmapped': 'Unmapped',
    'reports.devices.lastSeen': 'Last seen',
    'reports.mapping.title': 'Mapping Readiness',
    'reports.mapping.subtitle': 'Are people and device users mapped and ready?',
    'reports.mapping.people': 'People',
    'reports.mapping.activePeople': 'Active people',
    'reports.mapping.deviceUsers': 'Device users',
    'reports.mapping.activeMappings': 'Active mappings',
    'reports.mapping.unmappedUsers': 'Users needing mapping',
    'reports.mapping.peopleWithoutDevices': 'People without device',
    'reports.mapping.multiDevice': 'People on multiple devices',
    'reports.mapping.inactiveMappings': 'Inactive mappings',
    'reports.issues.title': 'Issues & Resolution',
    'reports.issues.subtitle': 'Operational issues that appeared inside the biometric system, open or resolved.',
    'reports.issues.problem': 'Issue',
    'reports.issues.total': 'Appeared in period',
    'reports.issues.resolved': 'Resolved',
    'reports.issues.open': 'Still open',
    'reports.issues.lastSeen': 'Last seen',
    'reports.issues.none': 'No issues appeared in the selected period.',
    'eventDetails.title': 'Event Details',
    'eventDetails.subtitle': 'Safe evidence fields for this biometric event.',
    'eventDetails.reference': 'Event reference',
    'eventDetails.personCode': 'Person code',
    'eventDetails.personName': 'Person name',
    'eventDetails.event': 'Event',
    'eventDetails.localTime': 'Local time',
    'eventDetails.utcTime': 'UTC time',
    'eventDetails.timezone': 'Timezone',
    'eventDetails.device': 'Device',
    'eventDetails.deviceSerial': 'Serial number',
    'eventDetails.verification': 'Verification',
    'eventDetails.version': 'Finalization version',
    'eventDetails.status': 'Status',
    'eventDetails.copyReference': 'Copy Event Reference',
    'eventDetails.copied': 'Event reference copied.',
    'success.refreshed': 'Data refreshed.',
    'success.personMapped': 'User mapped to the person.',
    'success.personMappedSelected': 'Mapped to the selected person.',
    'success.personCreatedMapped': 'Person added and mapped to the device.',
    'success.personCreated': 'Person added.',
    'success.reprocessed': '{message} {count} pending event(s) were processed automatically.',
    'validation.enterName': 'Enter the person name first.',
    'validation.customPeriod': 'Choose a start or end date for the custom period.',
    'error.personCodeConflict': 'This code is already used by another person.',
    'error.mappingConflict': 'This device user is already mapped.',
    'error.personInactive': 'The selected person is inactive.',
    'error.displayNameRequired': 'Person name is required.',
    'error.personNotFound': 'Person not found.',
    'error.deviceUserNotFound': 'Device user not found.',
    'error.historicalRange': 'Choose a valid start and end date, up to 31 days.',
    'error.historicalLimit': 'The period contains too many events. Choose a smaller period and try again.',
    'error.historicalChanged': 'The event set changed after preview. Preview the period again and retry.',
    'error.historicalConfirmation': 'Explicit reprocessing confirmation is required.',
    'error.generic': 'The operation could not be completed.',
    'issue.unmapped': 'Event from an unmapped user',
    'issue.mappingConflict': 'Mapping conflict',
    'issue.unknownEvent': 'Unknown event type',
    'issue.invalidTime': 'Invalid event time',
    'issue.inactivePerson': 'Event for an inactive person',
    'issue.finalizationError': 'Event finalization failed',
    'issue.autoFinalizationPending': 'Finalization pending',
    'issue.needsReview': 'Issue needs review',
    'issue.user': 'User {code}',
    'issue.unknownUser': 'Unknown user',
    'event.checkIn': 'Check In',
    'event.checkOut': 'Check Out',
    'event.breakOut': 'Break Out',
    'event.breakIn': 'Break In',
    'event.overtimeIn': 'Overtime In',
    'event.overtimeOut': 'Overtime Out',
    'event.generic': 'Event',
    'verification.fingerprint': 'Fingerprint',
    'verification.face': 'Face',
    'verification.palm': 'Palm',
    'verification.card': 'Card',
    'verification.password': 'Password',
    'verification.unknown': 'Not specified',
    'device.fallback': 'Device {id}'
  })
});

const state = {
  data: null,
  activeView: 'home',
  mappingDeviceUser: null,
  currentEvent: null,
  historicalPerson: null,
  historicalPreview: null,
  locale: readSavedLocale(),
  connection: 'connecting',
  pages: { events: null, people: null, unmapped: null, issues: null, devices: null },
  reports: null
};

const byId = (id) => document.getElementById(id);
const $all = (selector) => [...document.querySelectorAll(selector)];
const els = {
  connectionBadge: byId('connectionBadge'), refreshButton: byId('refreshButton'), languageButton: byId('languageButton'), notice: byId('notice'),
  summaryCards: byId('summaryCards'), attentionList: byId('attentionList'), homeEvents: byId('homeEvents'),
  unmappedList: byId('unmappedList'), unmappedTabCount: byId('unmappedTabCount'), unmappedPagination: byId('unmappedPagination'), unmappedFilters: byId('unmappedFilters'),
  eventsTable: byId('eventsTable'), eventsPagination: byId('eventsPagination'), eventsFilters: byId('eventsFilters'), eventsFilterSummary: byId('eventsFilterSummary'), exportEvents: byId('exportEvents'),
  issuesList: byId('issuesList'), issuesTabCount: byId('issuesTabCount'), issuesPagination: byId('issuesPagination'), issuesFilters: byId('issuesFilters'),
  peopleTable: byId('peopleTable'), peoplePagination: byId('peoplePagination'), peopleFilters: byId('peopleFilters'),
  devicesList: byId('devicesList'), devicesPagination: byId('devicesPagination'), devicesFilters: byId('devicesFilters'), vendorSelect: byId('vendorSelect'),
  showAddPerson: byId('showAddPerson'), addPersonForm: byId('addPersonForm'), cancelAddPerson: byId('cancelAddPerson'),
  mapDialog: byId('mapDialog'), cancelMapDialog: byId('cancelMapDialog'), mapDialogHint: byId('mapDialogHint'), personSelect: byId('personSelect'), mapExistingForm: byId('mapExistingForm'),
  eventDialog: byId('eventDialog'), eventDetails: byId('eventDetails'), closeEventDialog: byId('closeEventDialog'), closeEventDialogTop: byId('closeEventDialogTop'), copyEventReference: byId('copyEventReference'),
  historicalDialog: byId('historicalDialog'), historicalForm: byId('historicalForm'), historicalPersonHint: byId('historicalPersonHint'), historicalPreviewResult: byId('historicalPreviewResult'), historicalConfirm: byId('historicalConfirm'), historicalReprocessButton: byId('historicalReprocessButton'), historicalCancel: byId('historicalCancel'),
  reportsFilters: byId('reportsFilters'), reportHealth: byId('reportHealth'), reportDevicesTable: byId('reportDevicesTable'), reportMapping: byId('reportMapping'), reportIssuesSummary: byId('reportIssuesSummary'), reportIssuesTable: byId('reportIssuesTable')
};

applyLocale({ rerender: false });
bindEvents();
void refresh();

function bindEvents() {
  $all('.tab').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  els.refreshButton.addEventListener('click', () => refresh({ announce: true }));
  els.languageButton.addEventListener('click', switchLocale);
  els.showAddPerson.addEventListener('click', () => els.addPersonForm.classList.remove('hidden'));
  els.cancelAddPerson.addEventListener('click', () => els.addPersonForm.classList.add('hidden'));
  els.addPersonForm.addEventListener('submit', createPerson);
  els.mapExistingForm.addEventListener('submit', mapExistingPerson);
  els.cancelMapDialog.addEventListener('click', () => els.mapDialog.close());
  els.closeEventDialog.addEventListener('click', () => els.eventDialog.close());
  els.closeEventDialogTop.addEventListener('click', () => els.eventDialog.close());
  els.copyEventReference.addEventListener('click', copyEventReference);
  els.historicalForm.addEventListener('submit', previewHistoricalEvents);
  els.historicalReprocessButton.addEventListener('click', reprocessHistoricalEvents);
  els.historicalCancel.addEventListener('click', () => els.historicalDialog.close());
  els.historicalConfirm.addEventListener('change', updateHistoricalReprocessButton);
  els.historicalForm.elements.from.addEventListener('change', resetHistoricalPreview);
  els.historicalForm.elements.to.addEventListener('change', resetHistoricalPreview);
  els.exportEvents.addEventListener('click', exportEvents);

  els.eventsFilters.addEventListener('submit', (event) => { event.preventDefault(); void loadEvents(1); });
  els.peopleFilters.addEventListener('submit', (event) => { event.preventDefault(); void loadPeople(1); });
  els.unmappedFilters.addEventListener('submit', (event) => { event.preventDefault(); void loadUnmapped(1); });
  els.issuesFilters.addEventListener('submit', (event) => { event.preventDefault(); void loadIssues(1); });
  els.devicesFilters.addEventListener('submit', (event) => { event.preventDefault(); void loadDevices(1); });
  els.reportsFilters.addEventListener('submit', (event) => { event.preventDefault(); void loadReports(); });

  $all('[data-reset-filters]').forEach((button) => button.addEventListener('click', () => resetFilters(button.dataset.resetFilters)));
  $all('[data-period-select]').forEach((select) => select.addEventListener('change', () => toggleCustomRange(select.dataset.periodSelect)));
}

async function refresh({ announce = false } = {}) {
  setBusy(els.refreshButton, true);
  state.connection = 'connecting';
  renderConnection();
  try {
    state.data = await api('/api/overview');
    renderOverview();
    populateReferenceFilters();
    state.connection = 'connected';
    renderConnection();
    await loadActiveView({ preservePage: true });
    if (announce) showNotice(t('success.refreshed'));
  } catch (error) {
    state.connection = 'disconnected';
    renderConnection();
    showNotice(readableError(error), true);
  } finally {
    setBusy(els.refreshButton, false);
  }
}

function renderOverview() {
  const data = state.data;
  if (!data) return;
  renderSummary(data.dashboard || {});
  renderAttention(data.unmappedDeviceUsers || [], data.openIssues || []);
  renderHomeEvents((data.recentFinalEvents || []).slice(0, 6));
  els.unmappedTabCount.textContent = String(Number(data.dashboard?.unmappedDeviceUsers || 0));
  els.issuesTabCount.textContent = String(Number(data.dashboard?.openIssues || 0));
}

async function loadActiveView({ preservePage = false } = {}) {
  const loaders = {
    events: () => loadEvents(preservePage ? state.pages.events?.page?.number || 1 : 1),
    people: () => loadPeople(preservePage ? state.pages.people?.page?.number || 1 : 1),
    unmapped: () => loadUnmapped(preservePage ? state.pages.unmapped?.page?.number || 1 : 1),
    issues: () => loadIssues(preservePage ? state.pages.issues?.page?.number || 1 : 1),
    devices: () => loadDevices(preservePage ? state.pages.devices?.page?.number || 1 : 1),
    reports: () => loadReports()
  };
  if (loaders[state.activeView]) await loaders[state.activeView]();
}

async function loadEvents(page = 1) {
  const params = paramsFromForm(els.eventsFilters, { page, limit: 25, withPeriod: true });
  const result = await api(`/api/events?${queryString(params)}`);
  state.pages.events = result;
  renderEvents(result.items || []);
  renderPagination(els.eventsPagination, result.page, loadEvents);
  renderEventFilterSummary();
}

async function loadPeople(page = 1) {
  const params = paramsFromForm(els.peopleFilters, { page, limit: 25 });
  const result = await api(`/api/people?${queryString(params)}`);
  state.pages.people = result;
  renderPeople(result.items || []);
  renderPagination(els.peoplePagination, result.page, loadPeople);
}

async function loadUnmapped(page = 1) {
  const params = paramsFromForm(els.unmappedFilters, { page, limit: 20 });
  const result = await api(`/api/unmapped-device-users?${queryString(params)}`);
  state.pages.unmapped = result;
  renderUnmapped(result.items || []);
  renderPagination(els.unmappedPagination, result.page, loadUnmapped);
}

async function loadIssues(page = 1) {
  const params = paramsFromForm(els.issuesFilters, { page, limit: 20, withPeriod: true });
  const result = await api(`/api/issues?${queryString(params)}`);
  state.pages.issues = result;
  renderIssues(result.items || []);
  renderPagination(els.issuesPagination, result.page, loadIssues);
}

async function loadDevices(page = 1) {
  const params = paramsFromForm(els.devicesFilters, { page, limit: 20 });
  const result = await api(`/api/devices?${queryString(params)}`);
  state.pages.devices = result;
  renderDevices(result.items || []);
  renderPagination(els.devicesPagination, result.page, loadDevices);
}

async function loadReports() {
  const params = paramsFromForm(els.reportsFilters, { withPeriod: true });
  state.reports = await api(`/api/reports/operational?${queryString(params)}`);
  renderReports();
}

function paramsFromForm(form, { page = null, limit = null, withPeriod = false } = {}) {
  const data = new FormData(form);
  const output = {};
  for (const [key, value] of data.entries()) {
    if (['period', 'from', 'to'].includes(key)) continue;
    const text = String(value ?? '').trim();
    if (text) output[key] = text;
  }
  if (withPeriod) Object.assign(output, periodRange(form));
  if (page !== null) output.page = page;
  if (limit !== null) output.limit = limit;
  return output;
}

function periodRange(form) {
  const period = form.elements.period?.value || 'all';
  const today = startOfToday();
  if (period === 'all') return {};
  if (period === 'today') return { from: isoDay(today), to: isoDay(today) };
  if (period === 'yesterday') {
    const day = addDays(today, -1); return { from: isoDay(day), to: isoDay(day) };
  }
  if (period === 'last7') return { from: isoDay(addDays(today, -6)), to: isoDay(today) };
  if (period === 'month') return { from: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), to: isoDay(today) };
  if (period === 'custom') {
    const from = String(form.elements.from?.value || '').trim();
    const to = String(form.elements.to?.value || '').trim();
    if (!from && !to) { showNotice(t('validation.customPeriod'), true); return {}; }
    return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  }
  return {};
}

function queryString(params) {
  const names = { eventType: 'event_type', verificationMethod: 'verification_method', deviceId: 'device_id', issueType: 'issue_type' };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined || value === '') continue;
    search.set(names[key] || key, String(value));
  }
  return search.toString();
}

function renderSummary(dashboard) {
  const deviceInfo = dashboard.devices || {};
  const peopleInfo = dashboard.people || {};
  const unmapped = Number(dashboard.unmappedDeviceUsers || 0);
  const issues = Number(dashboard.openIssues || 0);
  const activeDevices = Number(deviceInfo.active || 0);
  const totalDevices = Number(deviceInfo.total || 0);
  const cards = [
    [t('dashboard.people'), Number(peopleInfo.active || 0), t('dashboard.peopleHint'), false],
    [t('dashboard.devices'), activeDevices, totalDevices === activeDevices ? t('dashboard.devicesActive') : t('dashboard.devicesOfTotal', { active: activeDevices, total: totalDevices }), false],
    [t('dashboard.unmapped'), unmapped, unmapped ? t('dashboard.needsAction') : t('dashboard.nothingPending'), unmapped > 0],
    [t('dashboard.issues'), issues, issues ? t('dashboard.reviewWhenNeeded') : t('dashboard.allGood'), issues > 0]
  ];
  els.summaryCards.replaceChildren(...cards.map(([label, value, hint, attention]) => summaryCard(label, value, hint, attention)));
}

function renderAttention(unmappedUsers, issues) {
  const nodes = [];
  if (unmappedUsers.length) {
    const item = el('div', 'item');
    item.append(el('div', 'item-title', t('attention.unmappedCount', { count: unmappedUsers.length })), el('div', 'item-meta', t('attention.unmappedHint')));
    const button = actionButton(t('attention.openMapping'), 'secondary');
    button.addEventListener('click', () => setView('unmapped'));
    const actions = el('div', 'item-actions'); actions.append(button); item.append(actions); nodes.push(item);
  }
  for (const issue of issues.filter((entry) => entry.issue_type !== 'unmapped_device_user').slice(0, 5)) {
    const item = el('div', 'item'); item.append(el('div', 'item-title', issueTitle(issue.issue_type)), el('div', 'item-meta', issueMeta(issue))); nodes.push(item);
  }
  els.attentionList.replaceChildren(...(nodes.length ? nodes : [empty(t('attention.none'))]));
}

function renderHomeEvents(events) {
  els.homeEvents.replaceChildren(...(events.length ? events.map((event) => {
    const item = el('div', 'item'); const top = el('div', 'item-row'); const wrap = document.createElement('div');
    wrap.append(el('div', 'item-title', event.person_name || isolate(event.person_code)), el('div', 'item-meta', `${eventLabel(event.event_type)} · ${isolate(localDateTime(event.event_time_local))}`));
    top.append(wrap, badge(t('events.final'), 'good')); item.append(top); return item;
  }) : [empty(t('events.none'))]));
}

function renderUnmapped(users) {
  if (!users.length) { els.unmappedList.replaceChildren(empty(t('unmapped.none'))); return; }
  els.unmappedList.replaceChildren(...users.map(unmappedCard));
}

function unmappedCard(user) {
  const card = el('article', 'item'); const top = el('div', 'item-row'); const titleWrap = document.createElement('div'); const code = isolate(user.device_user_id);
  titleWrap.append(el('div', 'item-title', user.display_name || t('unmapped.userNumber', { code })), el('div', 'item-meta', t('unmapped.deviceNumber', { code, device: deviceName(user) })));
  top.append(titleWrap, badge(t('unmapped.needsMapping'), 'warn')); card.append(top);
  const actions = el('div', 'item-actions');
  if (user.suggested_person_id && user.suggested_person_status === 'active') {
    const personName = user.suggested_person_name || isolate(user.suggested_person_code); const button = actionButton(t('unmapped.mapTo', { name: personName }), 'primary');
    button.addEventListener('click', () => runMapExisting(user, user.suggested_person_id, button)); actions.append(button, el('span', 'item-meta', t('unmapped.sameCodeFound', { code })));
  } else {
    const input = document.createElement('input'); input.placeholder = t('unmapped.personNamePlaceholder'); input.maxLength = 255; input.autocomplete = 'off'; input.value = user.display_name || ''; input.setAttribute('aria-label', t('unmapped.personNameAria', { code }));
    const button = actionButton(t('unmapped.addAndMap'), 'primary'); button.addEventListener('click', () => onboard(user, input, button)); actions.append(input, button);
    if (user.suggested_person_id && user.suggested_person_status !== 'active') actions.append(el('span', 'item-meta', t('unmapped.inactiveSameCode')));
  }
  const other = actionButton(t('unmapped.mapExisting'), 'ghost'); other.addEventListener('click', () => openMapDialog(user)); actions.append(other); card.append(actions); return card;
}

function renderEvents(events) {
  els.eventsTable.replaceChildren(...events.map((event) => {
    const row = document.createElement('tr'); const personName = event.person_name || t('events.noName'); const details = actionButton(t('actions.details'), 'ghost');
    details.addEventListener('click', () => openEventDetails(event.final_event_uuid));
    row.append(td(`${personName} (${isolate(event.person_code)})`), td(eventLabel(event.event_type), 'event-type'), td(localDateTime(event.event_time_local), 'number'), td(deviceName(event)), td(verificationLabel(event.verification_method)), tdNode(details)); return row;
  }));
  if (!events.length) els.eventsTable.append(emptyTableRow(6, t('events.noneTable')));
}

function renderIssues(issues) {
  if (!issues.length) { els.issuesList.replaceChildren(empty(t('issues.none'))); return; }
  els.issuesList.replaceChildren(...issues.map((issue) => {
    const item = el('article', 'item'); const top = el('div', 'item-row'); const wrap = document.createElement('div');
    wrap.append(el('div', 'item-title', issueTitle(issue.issue_type)), el('div', 'item-meta', issueMeta(issue)));
    const isOpen = issue.status === 'open'; top.append(wrap, badge(isOpen ? t('issues.open') : t('issues.resolved'), isOpen ? 'warn' : 'good'));
    item.append(top, el('div', 'item-meta issue-help', issueHelp(issue.issue_type)));
    if (!isOpen && issue.resolved_at) item.append(el('div', 'item-meta', t('issues.resolvedAt', { time: isolate(localDateTime(issue.resolved_at)) })));
    if (isOpen && issue.issue_type === 'unmapped_device_user') { const actions = el('div', 'item-actions'); const button = actionButton(t('issues.openMapping'), 'secondary'); button.addEventListener('click', () => setView('unmapped')); actions.append(button); item.append(actions); }
    return item;
  }));
}

function renderPeople(people) {
  els.peopleTable.replaceChildren(...people.map((person) => {
    const row = document.createElement('tr');
    const historical = actionButton(t('people.historicalAction'), 'ghost');
    historical.disabled = String(person.status || '').toLowerCase() !== 'active';
    historical.addEventListener('click', () => openHistoricalDialog(person));
    row.append(
      td(person.person_code, 'number'),
      td(person.display_name),
      tdNode(badge(personStatusLabel(person.status), person.status === 'active' ? 'good' : 'neutral')),
      td(String(person.mapped_device_users), 'number'),
      tdNode(historical)
    );
    return row;
  }));
  if (!people.length) els.peopleTable.append(emptyTableRow(5, t('people.none')));
}

function renderDevices(devices) {
  els.devicesList.replaceChildren(...(devices.length ? devices.map((device) => {
    const card = el('article', 'device-card'); card.append(el('h3', '', device.display_name || device.model || t('devices.biometricDevice')), el('div', 'serial', device.serial_number));
    const statuses = el('div', 'device-statuses'); statuses.append(badge(deviceStatusLabel(device.status), device.status === 'active' ? 'good' : 'bad'), badge(deviceModeLabel(device.mode), device.mode === 'test' ? 'warn' : 'neutral'));
    const lastSeen = localDateTime(device.last_seen_at) || t('devices.unknown'); const lastEvent = localDateTime(device.last_event_at) || t('devices.unknown');
    card.append(statuses, el('div', 'item-meta', t('devices.lastSeen', { time: isolate(lastSeen) })), el('div', 'item-meta', t('devices.lastEvent', { time: isolate(lastEvent) }))); return card;
  }) : [empty(t('devices.none'))]));
}

function renderReports() {
  const report = state.reports; if (!report) return;
  const h = report.systemHealth || {};
  const healthCards = [
    [t('reports.health.received'), h.canonical_punches ?? 0], [t('reports.health.final'), h.final_events ?? 0],
    [t('reports.health.issuesInPeriod'), h.issues_in_period ?? 0], [t('reports.health.openNow'), h.open_issues_now ?? 0], [t('reports.health.unmappedNow'), h.unmapped_now ?? 0]
  ];
  els.reportHealth.replaceChildren(...healthCards.map(([label, value]) => summaryCard(label, value, '', Number(value) > 0 && [t('reports.health.openNow'), t('reports.health.unmappedNow')].includes(label))));

  els.reportDevicesTable.replaceChildren(...(report.devices || []).map((device) => {
    const row = document.createElement('tr');
    const deviceText = `${device.display_name || device.model || t('devices.biometricDevice')} (${isolate(device.serial_number)})`;
    row.append(td(deviceText), tdNode(badge(deviceStatusLabel(device.status), device.status === 'active' ? 'good' : 'bad')), td(String(device.final_events_in_period || 0), 'number'), td(String(device.open_issues || 0), 'number'), td(String(device.unmapped_users || 0), 'number'), td(localDateTime(device.last_seen_at) || t('devices.unknown'), 'number')); return row;
  }));
  if (!(report.devices || []).length) els.reportDevicesTable.append(emptyTableRow(6, t('devices.none')));

  const m = report.mapping || {};
  const mappingCards = [
    [t('reports.mapping.people'), m.people_total ?? 0], [t('reports.mapping.activePeople'), m.active_people ?? 0], [t('reports.mapping.deviceUsers'), m.device_users_total ?? 0], [t('reports.mapping.activeMappings'), m.active_mappings ?? 0],
    [t('reports.mapping.unmappedUsers'), m.unmapped_device_users ?? 0], [t('reports.mapping.peopleWithoutDevices'), m.people_without_devices ?? 0], [t('reports.mapping.multiDevice'), m.people_multi_device ?? 0], [t('reports.mapping.inactiveMappings'), m.inactive_mappings ?? 0]
  ];
  els.reportMapping.replaceChildren(...mappingCards.map(([label, value]) => summaryCard(label, value, '', Number(value) > 0 && [t('reports.mapping.unmappedUsers'), t('reports.mapping.inactiveMappings')].includes(label))));

  const issues = report.issues || {};
  els.reportIssuesSummary.replaceChildren(
    summaryCard(t('reports.issues.total'), issues.total || 0), summaryCard(t('reports.issues.resolved'), issues.resolved || 0), summaryCard(t('reports.issues.open'), issues.open || 0, '', Number(issues.open || 0) > 0)
  );
  const issueRows = issues.items || [];
  els.reportIssuesTable.replaceChildren(...issueRows.map((issue) => {
    const row = document.createElement('tr'); const person = issue.person_name || (issue.device_user_id ? t('issue.user', { code: isolate(issue.device_user_id) }) : t('issue.unknownUser'));
    row.append(td(issueTitle(issue.issue_type)), td(person), td(deviceName(issue)), tdNode(badge(issue.status === 'open' ? t('issues.open') : t('issues.resolved'), issue.status === 'open' ? 'warn' : 'good')), td(localDateTime(issue.last_seen_at), 'number')); return row;
  }));
  if (!issueRows.length) els.reportIssuesTable.append(emptyTableRow(5, t('reports.issues.none')));
}

function renderEventFilterSummary() {
  const form = els.eventsFilters; const nodes = [];
  const add = (label, clear) => nodes.push(filterChip(label, clear));
  const search = form.elements.search.value.trim(); if (search) add(search, () => { form.elements.search.value = ''; void loadEvents(1); });
  const eventType = form.elements.eventType.value; if (eventType) add(eventLabel(eventType), () => { form.elements.eventType.value = ''; void loadEvents(1); });
  const deviceId = form.elements.deviceId.value; if (deviceId) { const option = form.elements.deviceId.selectedOptions[0]; add(option?.textContent || deviceId, () => { form.elements.deviceId.value = ''; void loadEvents(1); }); }
  const verification = form.elements.verificationMethod.value; if (verification) add(verificationLabel(verification === 'unknown' ? null : verification), () => { form.elements.verificationMethod.value = ''; void loadEvents(1); });
  const period = form.elements.period.value; if (period !== 'all') add(periodLabel(period), () => { form.elements.period.value = 'all'; toggleCustomRange('events'); void loadEvents(1); });
  els.eventsFilterSummary.replaceChildren(...nodes);
}

function renderPagination(container, page, loader) {
  if (!page) { container.replaceChildren(); return; }
  const wrap = el('div', 'pagination-inner');
  const meta = el('div', 'pagination-meta', `${t('pagination.total', { total: page.total })} · ${t('pagination.page', { page: page.number, pages: page.totalPages })}`);
  const actions = el('div', 'pagination-actions');
  const previous = actionButton(t('pagination.previous'), 'ghost'); previous.disabled = page.number <= 1; previous.addEventListener('click', () => loader(page.number - 1));
  const next = actionButton(t('pagination.next'), 'ghost'); next.disabled = page.number >= page.totalPages; next.addEventListener('click', () => loader(page.number + 1));
  actions.append(previous, next); wrap.append(meta, actions); container.replaceChildren(wrap);
}

function populateReferenceFilters() {
  const devices = state.data?.devices || [];
  for (const select of $all('[data-device-select]')) {
    const current = select.value; const first = select.querySelector('option[value=""]')?.cloneNode(true) || new Option(t('filters.allDevices'), '');
    const options = devices.map((device) => new Option(device.display_name || device.model || device.serial_number, String(device.id)));
    select.replaceChildren(first, ...options); select.value = current;
  }
  const vendors = [...new Set(devices.map((device) => device.vendor).filter(Boolean))].sort(); const currentVendor = els.vendorSelect.value;
  const firstVendor = els.vendorSelect.querySelector('option[value=""]')?.cloneNode(true) || new Option(t('filters.allVendors'), '');
  els.vendorSelect.replaceChildren(firstVendor, ...vendors.map((vendor) => new Option(vendor, vendor))); els.vendorSelect.value = currentVendor;
}

function resetFilters(name) {
  const forms = { events: els.eventsFilters, people: els.peopleFilters, unmapped: els.unmappedFilters, issues: els.issuesFilters, devices: els.devicesFilters };
  const form = forms[name]; if (!form) return; form.reset();
  if (name === 'events') form.elements.period.value = 'last7';
  if (name === 'issues') form.elements.period.value = 'all';
  toggleCustomRange(name);
  const loaders = { events: loadEvents, people: loadPeople, unmapped: loadUnmapped, issues: loadIssues, devices: loadDevices }; void loaders[name](1);
}

function toggleCustomRange(name) {
  const form = { events: els.eventsFilters, issues: els.issuesFilters, reports: els.reportsFilters }[name];
  const range = document.querySelector(`[data-custom-range="${name}"]`); if (!form || !range) return;
  range.classList.toggle('hidden', form.elements.period.value !== 'custom');
}

async function exportEvents() {
  const page = state.pages.events?.page;
  if (page?.total > 10000) { showNotice(t('events.exportLimit'), true); return; }
  const params = paramsFromForm(els.eventsFilters, { withPeriod: true }); params.lang = state.locale;
  window.location.assign(`/api/events/export.csv?${queryString(params)}`);
}

async function openEventDetails(uuid) {
  try {
    const result = await api(`/api/events/${encodeURIComponent(uuid)}`); state.currentEvent = result.event; renderEventDetails(result.event); els.eventDialog.showModal();
  } catch (error) { showNotice(readableError(error), true); }
}

function renderEventDetails(event) {
  const fields = [
    [t('eventDetails.reference'), event.final_event_uuid, 'number'], [t('eventDetails.personCode'), event.person_code, 'number'], [t('eventDetails.personName'), event.person_name || t('events.noName')],
    [t('eventDetails.event'), eventLabel(event.event_type)], [t('eventDetails.localTime'), localDateTime(event.event_time_local), 'number'], [t('eventDetails.utcTime'), localDateTime(event.event_time_utc), 'number'],
    [t('eventDetails.timezone'), event.event_timezone, 'number'], [t('eventDetails.device'), deviceName(event)], [t('eventDetails.deviceSerial'), event.serial_number || '', 'number'],
    [t('eventDetails.verification'), verificationLabel(event.verification_method)], [t('eventDetails.version'), event.finalization_version, 'number'], [t('eventDetails.status'), t('events.final')]
  ];
  els.eventDetails.replaceChildren(...fields.flatMap(([label, value, className = '']) => { const dt = el('dt', '', label); const dd = el('dd', className, value || '—'); return [dt, dd]; }));
}

async function copyEventReference() {
  const value = state.currentEvent?.final_event_uuid; if (!value) return;
  try { await navigator.clipboard.writeText(value); showNotice(t('eventDetails.copied')); }
  catch { showNotice(value); }
}

function openHistoricalDialog(person) {
  state.historicalPerson = person;
  els.historicalForm.reset();
  state.historicalPreview = null;
  els.historicalPersonHint.textContent = t('historical.person', { name: person.display_name, code: isolate(person.person_code) });
  els.historicalPreviewResult.textContent = '';
  els.historicalPreviewResult.classList.add('hidden');
  els.historicalReprocessButton.disabled = true;
  els.historicalDialog.showModal();
}

function resetHistoricalPreview() {
  state.historicalPreview = null;
  els.historicalConfirm.checked = false;
  els.historicalPreviewResult.textContent = '';
  els.historicalPreviewResult.classList.add('hidden');
  updateHistoricalReprocessButton();
}

async function previewHistoricalEvents(event) {
  event.preventDefault();
  if (!state.historicalPerson) return;
  const submit = els.historicalForm.querySelector('button[type="submit"]');
  const from = String(els.historicalForm.elements.from.value || '').trim();
  const to = String(els.historicalForm.elements.to.value || '').trim();
  setBusy(submit, true);
  try {
    const result = await api(`/api/people/${state.historicalPerson.id}/historical-events/preview?${queryString({ from, to })}`);
    state.historicalPreview = result;
    els.historicalConfirm.checked = false;
    const count = Number(result.count || 0);
    els.historicalPreviewResult.textContent = count
      ? `${t('historical.previewCount', { count })} ${result.earliestEventTimeLocal && result.latestEventTimeLocal ? t('historical.previewTimes', { from: isolate(localDateTime(result.earliestEventTimeLocal)), to: isolate(localDateTime(result.latestEventTimeLocal)) }) : ''}`.trim()
      : t('historical.previewNone');
    els.historicalPreviewResult.classList.remove('hidden');
    updateHistoricalReprocessButton();
  } catch (error) {
    resetHistoricalPreview();
    showNotice(readableError(error), true);
  } finally {
    setBusy(submit, false);
  }
}

function updateHistoricalReprocessButton() {
  const count = Number(state.historicalPreview?.count || 0);
  els.historicalReprocessButton.disabled = !(count > 0 && els.historicalConfirm.checked);
}

async function reprocessHistoricalEvents() {
  if (!state.historicalPerson || !state.historicalPreview) { showNotice(t('historical.needsPreview'), true); return; }
  const button = els.historicalReprocessButton;
  const from = String(els.historicalForm.elements.from.value || '').trim();
  const to = String(els.historicalForm.elements.to.value || '').trim();
  setBusy(button, true);
  try {
    const result = await api(`/api/people/${state.historicalPerson.id}/historical-events/reprocess`, {
      method: 'POST', body: { from, to, confirmed: els.historicalConfirm.checked === true }
    });
    const reissuedCount = Number(result.reissuedCount || 0);
    const message = reissuedCount > 0
      ? t('historical.success', { count: reissuedCount })
      : t('historical.zeroSuccess');
    state.historicalPreview = null;
    els.historicalConfirm.checked = false;
    els.historicalPreviewResult.textContent = message;
    els.historicalPreviewResult.classList.remove('hidden', 'error');
    els.historicalReprocessButton.disabled = true;
    showNotice(message);
    await refresh();
  } catch (error) {
    showNotice(readableError(error), true);
  } finally {
    setBusy(button, false);
  }
}

async function onboard(user, input, button) {
  const displayName = input.value.trim(); if (!displayName) { input.focus(); showNotice(t('validation.enterName'), true); return; }
  setBusy(button, true);
  try { const result = await api(`/api/device-users/${user.id}/onboard`, { method: 'POST', body: { displayName } }); showActionSuccess(result, t('success.personCreatedMapped')); await refresh(); }
  catch (error) { showNotice(readableError(error), true); } finally { setBusy(button, false); }
}

async function runMapExisting(user, personId, button) {
  setBusy(button, true);
  try { const result = await api(`/api/device-users/${user.id}/map`, { method: 'POST', body: { personId } }); showActionSuccess(result, t('success.personMapped')); await refresh(); }
  catch (error) { showNotice(readableError(error), true); } finally { setBusy(button, false); }
}

function openMapDialog(user) { state.mappingDeviceUser = user; if (!populateMapDialog(user)) return; els.mapDialog.showModal(); }
function populateMapDialog(user) {
  if (!user) return false; els.mapDialogHint.textContent = t('mapping.dialogHint', { code: isolate(user.device_user_id) });
  const people = (state.data?.people || []).filter((person) => person.status === 'active');
  els.personSelect.replaceChildren(...people.map((person) => { const option = document.createElement('option'); option.value = String(person.id); option.textContent = `${isolate(person.person_code)} — ${person.display_name}`; return option; }));
  if (!people.length) { showNotice(t('mapping.noActivePerson'), true); return false; } return true;
}

async function mapExistingPerson(event) {
  event.preventDefault(); if (!state.mappingDeviceUser) return; const button = byId('confirmMapExisting'); setBusy(button, true);
  try { const result = await api(`/api/device-users/${state.mappingDeviceUser.id}/map`, { method: 'POST', body: { personId: Number(els.personSelect.value) } }); els.mapDialog.close(); showActionSuccess(result, t('success.personMappedSelected')); await refresh(); }
  catch (error) { showNotice(readableError(error), true); } finally { setBusy(button, false); }
}

async function createPerson(event) {
  event.preventDefault(); const form = new FormData(els.addPersonForm); const submit = els.addPersonForm.querySelector('button[type="submit"]'); setBusy(submit, true);
  try { await api('/api/people', { method: 'POST', body: { personCode: form.get('personCode'), displayName: form.get('displayName') } }); els.addPersonForm.reset(); els.addPersonForm.classList.add('hidden'); showNotice(t('success.personCreated')); await refresh(); }
  catch (error) { showNotice(readableError(error), true); } finally { setBusy(submit, false); }
}

function showActionSuccess(result, fallback) { const finalized = (result.reprocessed || []).filter((entry) => entry.status === 'final').length; showNotice(finalized ? t('success.reprocessed', { message: fallback, count: finalized }) : fallback); }

function setView(name) {
  state.activeView = name; $all('.tab').forEach((button) => button.classList.toggle('active', button.dataset.view === name)); $all('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`)); window.scrollTo({ top: 0, behavior: 'smooth' });
  void loadActiveView();
}

function switchLocale() { state.locale = state.locale === 'ar' ? 'en' : 'ar'; saveLocale(state.locale); applyLocale(); }
function applyLocale({ rerender = true } = {}) {
  const isArabic = state.locale === 'ar'; document.documentElement.lang = state.locale; document.documentElement.dir = isArabic ? 'rtl' : 'ltr'; document.title = t('app.title');
  for (const node of $all('[data-i18n]')) { if (node.dataset.busy === 'true') continue; node.textContent = t(node.dataset.i18n); }
  for (const node of $all('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
  for (const node of $all('[data-i18n-placeholder]')) node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
  els.languageButton.textContent = t('language.switchText'); els.languageButton.setAttribute('aria-label', t('language.switchLabel')); els.languageButton.lang = isArabic ? 'en' : 'ar'; renderConnection();
  if (rerender) {
    if (state.data) { renderOverview(); populateReferenceFilters(); }
    if (state.pages.events) { renderEvents(state.pages.events.items || []); renderPagination(els.eventsPagination, state.pages.events.page, loadEvents); renderEventFilterSummary(); }
    if (state.pages.people) { renderPeople(state.pages.people.items || []); renderPagination(els.peoplePagination, state.pages.people.page, loadPeople); }
    if (state.pages.unmapped) { renderUnmapped(state.pages.unmapped.items || []); renderPagination(els.unmappedPagination, state.pages.unmapped.page, loadUnmapped); }
    if (state.pages.issues) { renderIssues(state.pages.issues.items || []); renderPagination(els.issuesPagination, state.pages.issues.page, loadIssues); }
    if (state.pages.devices) { renderDevices(state.pages.devices.items || []); renderPagination(els.devicesPagination, state.pages.devices.page, loadDevices); }
    if (state.reports) renderReports();
    if (els.eventDialog.open && state.currentEvent) renderEventDetails(state.currentEvent);
  }
  if (els.mapDialog.open && state.mappingDeviceUser) populateMapDialog(state.mappingDeviceUser);
  if (els.historicalDialog.open && state.historicalPerson) {
    els.historicalPersonHint.textContent = t('historical.person', { name: state.historicalPerson.display_name, code: isolate(state.historicalPerson.person_code) });
  }
}

async function api(url, options = {}) {
  const init = { method: options.method || 'GET', headers: {} };
  if (options.body !== undefined) { init.headers['content-type'] = 'application/json'; init.headers['x-biometric-admin'] = 'local-ui'; init.body = JSON.stringify(options.body); }
  const response = await fetch(url, init); const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.message || data.error || `HTTP ${response.status}`); error.code = data.error; throw error; } return data;
}

function renderConnection() {
  const configuration = { connecting: ['connection.connecting', 'neutral'], connected: ['connection.connected', 'good'], disconnected: ['connection.disconnected', 'bad'] }[state.connection] || ['connection.disconnected', 'bad'];
  els.connectionBadge.textContent = t(configuration[0]); els.connectionBadge.className = `badge ${configuration[1]}`;
}

function showNotice(message, error = false) { els.notice.textContent = message; els.notice.className = `notice${error ? ' error' : ''}`; window.clearTimeout(showNotice.timer); showNotice.timer = window.setTimeout(() => els.notice.classList.add('hidden'), error ? 7000 : 4000); }
function readableError(error) {
  const messages = {
    PERSON_CODE_CONFLICT: 'error.personCodeConflict', DEVICE_USER_MAPPING_CONFLICT: 'error.mappingConflict', PERSON_INACTIVE: 'error.personInactive',
    DISPLAY_NAME_REQUIRED: 'error.displayNameRequired', PERSON_NOT_FOUND: 'error.personNotFound', DEVICE_USER_NOT_FOUND: 'error.deviceUserNotFound',
    HISTORICAL_RANGE_REQUIRED: 'error.historicalRange', HISTORICAL_RANGE_INVALID: 'error.historicalRange', HISTORICAL_RANGE_TOO_LARGE: 'error.historicalRange',
    HISTORICAL_REPLAY_LIMIT: 'error.historicalLimit', HISTORICAL_REPLAY_CHANGED: 'error.historicalChanged', HISTORICAL_CONFIRMATION_REQUIRED: 'error.historicalConfirmation'
  };
  return messages[error?.code] ? t(messages[error.code]) : t('error.generic');
}

function issueHelp(type) { const keys = { unmapped_device_user: 'issues.unmappedHelp', mapping_conflict: 'issues.mappingConflictHelp', unknown_event_type: 'issues.unknownEventHelp', invalid_time: 'issues.invalidTimeHelp', inactive_person: 'issues.inactivePersonHelp', finalization_error: 'issues.finalizationErrorHelp', automatic_finalization_pending: 'issues.autoFinalizationPendingHelp' }; return t(keys[type] || 'issues.genericHelp'); }
function issueTitle(type) { const keys = { unmapped_device_user: 'issue.unmapped', mapping_conflict: 'issue.mappingConflict', unknown_event_type: 'issue.unknownEvent', invalid_time: 'issue.invalidTime', inactive_person: 'issue.inactivePerson', finalization_error: 'issue.finalizationError', automatic_finalization_pending: 'issue.autoFinalizationPending' }; return t(keys[type] || 'issue.needsReview'); }
function issueMeta(issue) { const who = issue.person_name || (issue.device_user_id ? t('issue.user', { code: isolate(issue.device_user_id) }) : t('issue.unknownUser')); return `${who} · ${eventLabel(issue.punch_state)} · ${isolate(localDateTime(issue.device_event_time_local))}`; }
function eventLabel(type) { const keys = { check_in: 'event.checkIn', check_out: 'event.checkOut', break_out: 'event.breakOut', break_in: 'event.breakIn', overtime_in: 'event.overtimeIn', overtime_out: 'event.overtimeOut' }; return keys[type] ? t(keys[type]) : (type || t('event.generic')); }
function verificationLabel(method) { const keys = { fingerprint: 'verification.fingerprint', face: 'verification.face', palm: 'verification.palm', card: 'verification.card', password: 'verification.password' }; return keys[method] ? t(keys[method]) : (method || t('verification.unknown')); }
function personStatusLabel(status) { return String(status || '').toLowerCase() === 'active' ? t('people.active') : t('people.inactive'); }
function deviceStatusLabel(status) { return String(status || '').toLowerCase() === 'active' ? t('devices.available') : t('devices.unavailable'); }
function deviceModeLabel(mode) { const value = String(mode || '').toLowerCase(); if (value === 'test') return t('devices.testMode'); if (value === 'live') return t('devices.liveMode'); if (value === 'maintenance') return t('devices.maintenanceMode'); return t('devices.unknownMode'); }
function deviceName(row) { if (row.device_display_name) return row.device_display_name; if (row.display_name) return row.display_name; if (row.device_model || row.model) return row.device_model || row.model; if (row.serial_number) return isolate(row.serial_number); return t('device.fallback', { id: row.device_id ?? row.id ?? '' }).trim(); }
function periodLabel(period) { const keys = { today: 'period.today', yesterday: 'period.yesterday', last7: 'period.last7', month: 'period.month', all: 'period.all', custom: 'period.custom' }; return t(keys[period] || 'period.all'); }

function localDateTime(value) { if (!value) return ''; const text = String(value).replace('T', ' ').replace(/Z$/, '').replace(/\.\d+$/, ''); const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}:\d{2})(?::\d{2})?/); return match ? `${match[3]}/${match[2]}/${match[1]} ${match[4]}` : text; }
function t(key, variables = {}) { const dictionary = translations[state.locale] || translations.ar; const fallback = translations.ar[key] || key; const template = dictionary[key] || fallback; return Object.entries(variables).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value ?? '')), template); }
function readSavedLocale() { try { return window.localStorage.getItem('biometric-admin-language') === 'en' ? 'en' : 'ar'; } catch { return 'ar'; } }
function saveLocale(locale) { try { window.localStorage.setItem('biometric-admin-language', locale); } catch { /* optional */ } }
function isolate(value) { const text = String(value ?? ''); return text ? `\u2066${text}\u2069` : ''; }
function startOfToday() { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()); }
function addDays(date, days) { const copy = new Date(date); copy.setDate(copy.getDate() + days); return copy; }
function isoDay(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }

function summaryCard(label, value, hint = '', attention = false) { const card = el('article', `summary-card${attention ? ' attention' : ''}`); card.append(el('div', 'value number', String(value ?? 0)), el('div', 'label', label)); if (hint) card.append(el('div', 'item-meta', hint)); return card; }
function filterChip(text, onRemove) { const button = el('button', 'filter-chip', `${text} ×`); button.type = 'button'; button.addEventListener('click', onRemove); return button; }
function badge(text, tone) { return el('span', `badge ${tone}`, text); }
function actionButton(text, tone) { const button = el('button', `button ${tone}`, text); button.type = 'button'; button.dataset.idleText = text; return button; }
function setBusy(button, busy) { if (!button) return; button.disabled = busy; button.dataset.busy = busy ? 'true' : 'false'; if (busy) { if (!button.dataset.idleText) button.dataset.idleText = button.textContent; button.textContent = t('actions.busy'); return; } if (button.dataset.i18n) button.textContent = t(button.dataset.i18n); else if (button.dataset.idleText) button.textContent = button.dataset.idleText; }
function el(tag, className = '', text = null) { const node = document.createElement(tag); if (className) node.className = className; if (text !== null) node.textContent = text; return node; }
function td(text, className = '') { return el('td', className, text); }
function tdNode(node) { const cell = document.createElement('td'); cell.append(node); return cell; }
function empty(text) { return el('div', 'empty', text); }
function emptyTableRow(colspan, text) { const row = document.createElement('tr'); const cell = td(text, 'muted'); cell.colSpan = colspan; row.append(cell); return row; }
