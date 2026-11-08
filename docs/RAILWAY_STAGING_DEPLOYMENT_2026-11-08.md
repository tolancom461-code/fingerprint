# نشر نظام البصمة التجريبي على Railway

هذه التجربة تشغل خدمة البصمة المستقلة للتحقق من بناء الحزمة والاستماع على منفذ Railway واستجابة HTTPS. تستخدم مدخلًا مخصصًا يرفض جميع الأجهزة، ولا يصل إلى TiDB أو TolanHR، ولا يعرض الإدارة أو API. نجاحها يثبت جاهزية البنية للتشغيل فقط؛ استقبال الجهاز الحقيقي والإدارة عن بعد ونقل التاريخ خطوات لاحقة.

## ملفات النشر

| الملف | الوظيفة |
| --- | --- |
| `Dockerfile` | صورة Node 22، تثبيت من lockfile، وتشغيل التجربة كمستخدم `node` |
| `src/railway-staging.js` | مدخل التجربة الذي يطبق العزل قبل تحميل الخدمة الحالية |
| `src/config/railway-staging.js` | إعدادات منفذ ومسارات وقيود التجربة |
| `.env.railway.staging.example` | متغيرات عامة دون أسرار |
| `deploy/railway-staging.settings.json` | مرجع إعدادات يطبق من لوحة Railway؛ ليس ملفًا تقرؤه Railway تلقائيًا |

توثق Railway أن `railway.json` و`railway.toml` آلية قديمة لا تتاح للخدمات الجديدة، وأن البديل هو Infrastructure as Code. لهذا لا تعتمد هذه الحزمة على ملف Config as Code قديم؛ يكتشف Dockerfile ويضبط فحص الصحة من إعدادات الخدمة. يمكن أتمتة إعدادات الحساب لاحقًا باستخدام IaC بعد تحديد المشروع وبيئة التجربة. [مرجع Railway](https://docs.railway.com/infrastructure-as-code).

## إنشاء خدمة منفصلة

1. استخدم مشروعًا أو بيئة تجربة مستقلة، وأنشئ خدمة باسم مقترح `biometric-staging`. لا تنشر الحزمة فوق خدمة TolanHR ولا تنسخ متغيرات الإنتاج إلى التجربة.
2. اربط مصدر المشروع المستقل. إذا كان محتوى `biometric-system` جذر المستودع، تكون Root Directory هي `/`. وإذا كان المستودع يحتوي مجلد `biometric-system` بجوار `finger`، تكون Root Directory هي `/biometric-system`. سياق Docker يجب أن يكون مجلد البصمة فقط.
3. اختر بناء Dockerfile الموجود في جذر هذا المجلد. لا يوجد أمر build مخصص أو pre-deploy أو أمر ترحيل قاعدة لهذه التجربة.
4. اترك Start Command فارغًا لاستخدام `CMD` في الصورة، أو اضبطه على `node src/railway-staging.js` بالضبط. لا تستخدم `npm start` أو `node src/index.js` على خدمة التجربة؛ المدخل المحلي الأصلي لا يطبق عزل التجربة.
5. اضبط متغيري `NODE_ENV=production` و`PORT=8080`. لا تضف مفاتيح قاعدة البيانات أو الجهاز أو Web Bridge أو أسرار TolanHR. يقرأ المدخل `PORT` ويستمع على `0.0.0.0`، ويرفض قيمة المنفذ غير الصحيحة.
6. اضبط Healthcheck Path على `/health` ومهلة 60 ثانية، وسياسة إعادة التشغيل `ON_FAILURE` بحد ثلاث محاولات، ونسخة تشغيل واحدة. هذا فحص قبول للنشر وليس مراقبة مستمرة. [فحوص Railway](https://docs.railway.com/deployments/healthchecks).
7. أنشئ نطاق Railway تجريبيًا للخدمة، واضبط Target Port على `8080` مطابقًا لقيمة `PORT`. لا تغير نطاق `www.tolanhr.com` أو إعداد Cloud Server في جهاز البصمة.

يستخدم Dockerfile أمر تشغيل بصيغة exec لضمان وصول إشارات الإيقاف إلى Node. Railway يكتشف Dockerfile تلقائيًا من جذر المصدر؛ أي Start Command من اللوحة يجب أن يظل مطابقًا لمدخل التجربة. [Dockerfiles](https://docs.railway.com/builds/dockerfiles)، [أمر التشغيل](https://docs.railway.com/deployments/start-command).

## ما تفرضه التجربة

- تخزين ملفي منفصل بدل قاعدة البيانات، حتى لو ورثت العملية متغيرات قاعدة قديمة.
- قائمة أجهزة فارغة لكل من متغير الأجهزة ومتغير الأرقام التسلسلية القديم؛ أي طلب ADMS يرفض.
- تعطيل الإدارة وAPI والأتمتة المالية والتوصيل إلى البرامج، دون قراءة ملفات `.env` أو سجلات الجهاز الأصلية.
- ملفات تشغيل في مجلد تجربة مخصص. لا يستخدم `var/web-bridge-state.json` الخاص بالإنتاج، ولا يحدث أي مؤشر إنتاج.

في هذه التجربة لا توجد بيانات جهاز مطلوب الاحتفاظ بها؛ لذلك يجوز بدء التجربة دون Volume، وتعتبر الملفات التشغيلية مؤقتة. لا تستخدم هذا الترتيب لتخزين حركات حقيقية.

إذا أضيف Volume لاحقًا، يتحقق من المسار والصلاحيات أثناء التشغيل قبل قبول أي بيانات. مجلد Volume يركب عند runtime وقد يملكه `root`، بينما الصورة تعمل بمستخدم `node`؛ لا يكفي `chown` أثناء البناء لضمان صلاحيات Volume. لا يربط Volume إنتاجي بهذه التجربة. [وثائق Volumes](https://docs.railway.com/volumes).

## اختبار النشر من CMD

استبدل `YOUR-STAGING-DOMAIN` بالنطاق الفعلي للخدمة الجديدة:

```cmd
curl.exe --connect-timeout 5 --max-time 10 https://YOUR-STAGING-DOMAIN/health
```

المتوقع HTTP 200 والنص `OK`.

```cmd
curl.exe -i --connect-timeout 5 --max-time 10 "https://YOUR-STAGING-DOMAIN/iclock/cdata?SN=STAGING-TEST&options=all"
```

المتوقع HTTP 403؛ هذا رفض مطلوب لجهاز افتراضي، ولا يمثل اختبارًا على الجهاز الحقيقي.

```cmd
curl.exe -i --connect-timeout 5 --max-time 10 https://YOUR-STAGING-DOMAIN/api/overview
```

المتوقع HTTP 404. هذه التجربة لا تنشر واجهة إدارة الأجهزة للعامة.

راجع سجل النشر للتأكد من ظهور وضع التجربة، و`allowed devices: 0`، و`storage mode: file` وتعطيل Web Bridge. لا تدخل حركات حقيقية في التجربة ولا تضبط بيانات قاعدة إنتاج لاختبار `/health`.

## التحقق المحلي

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

لتشغيل التجربة محليًا باستخدام المنفذ الافتراضي 8080:

```powershell
npm run start:railway-staging
```

إذا كان Docker Engine متاحًا:

```powershell
docker build -t biometric-staging .
docker run --rm -p 127.0.0.1:8080:8080 biometric-staging
```

## التحويل والتراجع

هذه الحزمة لا تحول التشغيل المثبت أو عنوان الجهاز أو قاعدة البيانات. التراجع عن التجربة هو إيقاف خدمة `biometric-staging` الجديدة بعد التحقق من هويتها. يبقى تشغيل الإنتاج منفصلًا عنها.

قبل تجربة حركات حقيقية، يلزم استكمال الوصول الآمن ومصادقة الأجهزة، وقاعدة تجربة مستقلة وحفظ دائم مجرب، واستخراج التاريخ القديم ومصالحته، وإدارة مستقلة مناسبة. يتطلب نقل الإنتاج نقطة تحويل ومؤشرات محفوظة وخطة رجوع تشمل ما جمع بعد التحويل.
